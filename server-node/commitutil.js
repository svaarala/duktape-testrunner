/*
 *  Commit job handling.
 */

var fs = require('fs');
var path = require('path');
var Promise = require('bluebird');

var dbutil = require('./dbutil');
var util = require('./util');
var assert = util.assert;
var expressutil = require('./expressutil');
var sendJsonReply = expressutil.sendJsonReply;

// Tracking table for hanging get-commit-simple, i.e. clients waiting for a
// job to execute.  Clients will be hanging most of the time which avoids
// slow response time due to periodic polling.
var getCommitRequests = [];
var getCommitRequestsCount = null;  // for logging

function filterOldCommits(state, docs, now) {
    return docs.filter(function (doc) {
        return (now - doc.time <= state.oldCommitAgeDays * 24 * 3600e3);
    });
}

function sortCommitsByDate(state, docs) {
    docs.sort(function (a, b) {
        if (typeof a.time !== 'number' || typeof b.time !== 'number') {
            return 0;
        }
        if (a.time > b.time) {
            return -1;
        } else if (b.time > a.time) {
            return 1;
        }
        return 0;
    });
    return docs;  // in-place actually
}

// Recheck pending get-commit-simple requests: if new matching jobs are
// available, respond to the client and remove the tracking state.  Also
// handles request timeouts.
function handleGetCommitRequests(state) {
    var db = assert(state.db);
    var github = assert(state.github);
    var now = Date.now();

    // XXX: Quite inefficient but good enough for now.

    dbutil.find(db, {
        type: 'commit_simple'
    }).then(function (docs) {
        if (!docs || docs.length <= 0) { return; }

        // Remove old webhooks that we don't want to reprocess.
        docs = filterOldCommits(state, docs, now);

        // Sort docs: newest (largest) first, so we execute latest jobs and
        // then back in time.
        docs = sortCommitsByDate(state, docs);

        docs.forEach(function (doc) {
            getCommitRequests = getCommitRequests.filter(function (client) {
                var i, j, ctx, run, found;

                // XXX: This is racy at the moment, rework to only send a
                // client response when the database has been updated.

                if (now - client.time >= 300e3) {
                    console.log('client request for simple commit job timed out');
                    sendJsonReply(client.res, {
                        error_code: 'TIMEOUT'
                    });  // XXX
                    return false;  // remove
                }

                for (i = 0; i < client.contexts.length; i++) {
                    ctx = client.contexts[i];
                    found = false;
                    for (j = 0; j < doc.runs.length; j++) {
                        run = doc.runs[j];
                        if (run.context === ctx) {
                            found = true;
                        }
                    }
                    if (!found) {
                        // Context ctx not found in runs already, add to runs
                        // and respond to client.

                        doc.runs.push({
                            start_time: Date.now(),
                            end_time: null,
                            context: ctx
                        });

                        dbutil.updateOne(db, {
                            _id: doc._id
                        }, {
                            $set: {
                                runs: doc.runs
                            }
                        }).catch(function (err) {
                            if (err) { throw err; }
                        });
                        // FIXME: proper Promise handling

                        console.log('start simple commit job for sha ' + doc.sha + ', context ' + ctx);
                        sendJsonReply(client.res, {
                            repo: assert(doc.repo),
                            repo_full: assert(doc.repo_full),
                            repo_clone_url: assert(doc.repo_clone_url),
                            sha: assert(doc.sha),
                            fetch_ref: doc.fetch_ref,  // for pulls
                            context: ctx
                        });

                        require('./githubutil').createGithubStatus(state, {
                            user: assert(state.githubStatusUsername),
                            repo: assert(doc.repo),
                            sha: assert(doc.sha),
                            context: assert(ctx),
                            state: 'pending',
                            target_url: 'http://duktape.org/',  // XXX: useful temporary URI? web UI job status?
                            description: 'Running... (' + (client.client_name || 'no client name') + ')'
                        });

                        // XXX: error recovery / restart; check for start_time
                        // age over sanity (24h?) and remove/reassign job

                        return false;  // no longer pending
                    }
                }

                // No context found, keep in pending state.
                return true;
            });
        });

        var pendingAfter = getCommitRequests.length;
        if (pendingAfter !== getCommitRequestsCount) {
            console.log('pending clients: ' + getCommitRequestsCount + ' -> ' + pendingAfter);
        }
        getCommitRequestsCount = pendingAfter;
    }).catch(function (err) {
        console.log(err);
    });
}

// Find commit contexts whose pending job is too old and make the context
// eligible for a re-run.
function handleAutoFailPending(state) {
    var db = assert(state.db);
    var github = assert(state.github);
    var now = Date.now();

    dbutil.find(db, {
        type: 'commit_simple'
    }).then(function (docs) {
        var rerunCount = 0;

        if (!docs || docs.length <= 0) { return; }

        docs = filterOldCommits(state, docs, now);
        docs = sortCommitsByDate(state, docs);

        docs.forEach(function (doc) {
            var i;
            var newRuns;

            if (!doc.runs) {
                console.log('doc has no .runs');
                return;
            }

            newRuns = doc.runs.map(function (run) {
                var ageDays;
                if (typeof run.start_time !== 'number') {
                    console.log('run .start_time missing or invalid');
                    return run;
                }
                if (typeof run.end_time === 'number') {
                    return run;
                }
                ageDays = (now - run.start_time) / (24 * 3600e3);
                if (ageDays < state.pendingAutoFailDays) {
                    return run;
                }
                console.log('pending run too old, ' + ageDays + ' days, make eligible for re-run: commit: ' +
                            doc.sha + ', context ' + run.context);
                rerunCount++;

                // For now just remove the run entirely.  This is not ideal
                // but context eligibility check doesn't handle existing runs
                // yet.
                return null;
            });
            newRuns = newRuns.filter(function (run) { return run !== null; });

            if (doc.runs.length !== newRuns.length) {
                console.log('commit ' + doc.sha + ', oldRuns ' + doc.runs.length + ' -> ' + newRuns.length);

                // FIXME: proper Promise handling
                dbutil.updateOne(db, {
                    _id: doc._id
                }, {
                    $set: {
                        runs: newRuns
                    }
                }).catch (function (err) {
                    console.log(err);
                    if (err) { throw err; }
                });
            }
        });

        console.log('automatic re-runs for ' + rerunCount + ' contexts');
    });
}

// Create a get-commit-simple handler.
function makeGetCommitSimpleHandler(state) {
    return function getCommitSimpleHandler(req, res) {
        var body = req.body;
        if (typeof body !== 'object') {
           throw new Error('invalid POST body, perhaps client is missing Content-Type?');
        }

        // body.contexts: list of contexts supported

        // FIXME: persist job in database instead

        getCommitRequests.push({
            time: Date.now(),
            res: res,
            contexts: assert(body.contexts),
            client_name: body.client_name
        });
        handleGetCommitRequests(state);

        // FIXME: timeout if client doesn't explicitly accept job
    };
}

// Create a accept-commit-simple handler.
function makeAcceptCommitSimpleHandler(state) {
    return function acceptCommitSimpleHandler(req, res) {
        var body = req.body;
        if (typeof body !== 'object') {
           throw new Error('invalid POST body, perhaps client is missing Content-Type?');
        }

        // FIXME: mark job as accepted
    };
}

// Create a finish-commit-simple handler.
function makeFinishCommitSimpleHandler(state) {
    var db = assert(state.db);
    var github = assert(state.github);

    return function finishCommitSimpleHandler(req, res) {
        var body = req.body;
        if (typeof body !== 'object') {
           throw new Error('invalid POST body, perhaps client is missing Content-Type?');
        }

        // XXX: add an explicit webhook identifier to update the exact 'commit_simple'
        // instead of the awkward scan below?

        // body.repo_full
        // body.sha
        // body.context
        // body.state        success/failure
        // body.description  oneline description
        // body.text         text, automatically served, github status URI will point to this text file
        // body.result       arbitrary json result object

        function fail(code, desc) {
            var rep = { error_code: code, error_description: desc };
            var repData = new Buffer(JSON.stringify(rep), 'utf8');
            res.setHeader('content-type', 'application/json');
            res.send(repData);
        }

        dbutil.find(db, {
            type: 'commit_simple',
            repo_full: assert(body.repo_full),
            sha: assert(body.sha)
        }).then(function (docs) {
            var doc, i, run;

            // XXX: This is racy now.  Client should also be allowed to retry
            // persistently even if we respond but the response is lost.

            if (!docs || docs.length <= 0) {
                throw new Error('target webhook commit not found');
            }
            if (docs.length > 1) {
                console.log('more than one commit_simple docs found');
            }
            doc = docs[docs.length - 1];

            var output = new Buffer(assert(body.text), 'base64');
            var outputSha = util.sha1sum(output);
            var outputFn = path.join(state.dataDumpDirectory, outputSha);
            var outputUri = assert(state.webBaseUri) + '/out/' + outputSha;
            fs.writeFileSync(outputFn, output);
            console.log('wrote output data to ' + outputFn + ', ' + output.length + ' bytes' +
                        ', link is ' + outputUri);

            for (i = 0; i < doc.runs.length; i++) {
                run = doc.runs[i];
                if (run.context === body.context) {
                    if (run.end_time !== null) {
                        console.log('finish-commit-job already finished, ignoring');
                    } else {
                        run.end_time = Date.now();
                        run.output_uri = outputUri;
                        run.state = body.state;
                        run.description = body.description;
                        run.result = body.result || {};

                        console.log('finish-commit-job for sha ' + body.sha + ', context ' + body.context + '; took ' +
                                    (run.end_time - run.start_time) / 60e3 + ' mins');

                        dbutil.updateOne(db, {
                            _id: doc._id
                        }, {
                            $set: {
                                runs: doc.runs
                            }
                        }).catch (function (err) {
                            console.log(err);
                            if (err) { throw err; }
                        });
                        // FIXME: proper Promise handling
                    }

                    sendJsonReply(res, {});

                    require('./githubutil').updateGithubStatus(state, {
                        user: assert(state.githubStatusUsername),
                        repo: assert(doc.repo),
                        sha: assert(doc.sha),
                        context: assert(body.context),
                        state: assert(body.state),
                        description: assert(body.description),
                        target_url: assert(outputUri)
                    });

                    return;
                }
            }

            throw new Error('cannot find internal tracking state for context');
        }).catch(function (err) {
            console.log(err);
            fail('INTERNAL_ERROR', String(err));
        });
    }
}

// Create a query-commit-simple handler.
function makeQueryCommitSimpleHandler(state) {
    var db = assert(state.db);
    var github = assert(state.github);

    return function queryCommitSimpleHandler(req, res) {
        var body = req.body;
        if (typeof body !== 'object') {
           throw new Error('invalid POST body, perhaps client is missing Content-Type?');
        }
        var hashes;
        var multi = false;
        if (typeof body.sha === 'string') {
            hashes = [ body.sha ];
        } else if (typeof body.sha_list === 'object') {
            hashes = body.sha_list;
            multi = true;
        }

        function fail(code, desc) {
            var rep = { error_code: code, error_description: desc };
            var repData = new Buffer(JSON.stringify(rep), 'utf8');
            res.setHeader('content-type', 'application/json');
            res.send(repData);
        }

        var promises = hashes.map(function (hash) {
            return dbutil.find(db, {
                type: 'commit_simple',
                repo_full: assert(body.repo_full),
                sha: assert(hash)
            }).then(function (docs) {
                var doc;
                if (!docs || docs.length <= 0) {
                    return { error: 'commit ' + hash + ' not found' };
                }
                if (docs.length > 1) {
                    console.log('more than one commit_simple docs found, use first; hash ' + hash);
                }
                doc = docs[docs.length - 1];
                return doc;
            });
        });

        Promise.all(promises).then(function (values) {
            sendJsonReply(res, multi ? values : values[0]);
        }).catch(function (err) {
            console.log(err.stack || err);
            fail('INTERNAL_ERROR', String(err));
        });
    }
}

exports.handleGetCommitRequests = handleGetCommitRequests;
exports.handleAutoFailPending = handleAutoFailPending;
exports.makeGetCommitSimpleHandler = makeGetCommitSimpleHandler;
exports.makeAcceptCommitSimpleHandler = makeAcceptCommitSimpleHandler;
exports.makeFinishCommitSimpleHandler = makeFinishCommitSimpleHandler;
exports.makeQueryCommitSimpleHandler = makeQueryCommitSimpleHandler;
