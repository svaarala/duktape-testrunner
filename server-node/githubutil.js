/*
 *  Github API and Webhook handling.
 */

var fs = require('fs');
var path = require('path');

var dbutil = require('./dbutil');
var util = require('./util');
var assert = util.assert;
var expressutil = require('./expressutil');
var sendJsonReply = expressutil.sendJsonReply;

function createGithubStatus(state, status) {
    var db = assert(state.db);
    var github = assert(state.github);

    db.find({
        type: 'github_status',
        user: assert(status.user),
        repo: assert(status.repo),
        sha: assert(status.sha),
        context: assert(status.context)
    }, function (err, docs) {
        var doc;
        if (err) { console.log(err); return; }
        if (docs && docs.length > 0) {
            console.log('github-status already exists');
            return;
        }

        db.insert({
            type: 'github_status',
            user: assert(status.user),
            repo: assert(status.repo),
            sha: assert(status.sha),
            state: assert(status.state),
            target_url: assert(status.target_url),
            description: assert(status.description),
            context: assert(status.context),
            dirty: true
        });
    });
}

// Update an existing github status and mark it dirty.
function updateGithubStatus(state, status) {
    var db = assert(state.db);
    var github = assert(state.github);

    db.find({
        type: 'github_status',
        user: assert(status.user),
        repo: assert(status.repo),
        sha: assert(status.sha),
        context: assert(status.context)
    }, function (err, docs) {
        var doc;
        if (err) { console.log(err); return; }
        if (!docs || docs.length <= 0) {
            console.log('github-status not found');
            return;
        }
        if (docs.length >= 2) {
            console.log('more than one github-status matches, unexpected');
        }
        doc = docs[docs.length - 1];

        var setValues = { dirty: true };
        function check(key) {
            if (typeof status[key] !== 'undefined') {
                setValues[key] = status[key];
            }
        }
        check('state');
        check('target_url');
        check('description');

        db.update({
            _id: doc._id
        }, {
            $set: setValues
        }, function (err, numReplaced) {
            if (err) { throw err; }
        });
    });
}

// Push dirty github status items.  Rate limit Github operations to avoid
// behaving badly even if something goes wrong and we end up retrying a
// push indefinitely.
function pushGithubStatuses(state) {
    var db = assert(state.db);
    var github = assert(state.github);

    db.find({
        type: 'github_status',
        dirty: true
    }, function (err, docs) {
        if (err) { console.log(err); return; }
        if (!docs || docs.length <= 0) { return; }

        docs.forEach(function (doc) {
            state.githubLimiter.removeTokens(1, function (err, remainingTokens) {
                if (err) {
                    console.log(err);
                    return;
                }
                if (remainingTokens < 0) {
                    console.log('skip github status push, rate limited');
                    return;
                }

                console.log('push github status for repo ' + doc.user + '/' + doc.repo +
                            ', commit ' + doc.sha + ', context ' + doc.context +
                            ', state ' + doc.state + '; tokens left: ' + remainingTokens);

                github.authenticate({
                    type: 'basic',
                    username: assert(state.githubAuthUsername),
                    password: assert(state.githubAuthPassword)
                });
                github.statuses.create({
                    user: assert(doc.user),
                    repo: assert(doc.repo),
                    sha: assert(doc.sha),
                    state: assert(doc.state),
                    target_url: assert(doc.target_url),
                    description: assert(doc.description),
                    context: assert(doc.context),
                }, function statusCreated(err, ret) {
                    //console.log('status created:', err, ret);
                    if (err) {
                        console.log(err);

                        // If commit is not found, Github returns something like:
                        // { message: '{"message":"No commit found for SHA: 239e1a240b70576ca123aa14f75c7a5781f6e8c5","documentation_url":"https://developer.github.com/v3/repos/statuses/"}',
                        //   code: 422 }
                        //
                        // Don't retry indefinitely.
                        // XXX: Better fix is a backoff and try count.

                        if (err.code === 422) {
                            console.log('commit no longer exists, don\'t retry status push');
                            // fall through and mark non-dirty
                        } else {
                            return;
                        }
                    }

                    db.update({
                        _id: doc._id
                    }, {
                        $set: {
                            dirty: false
                        },
                    }, function (err, numReplaced) {
                        if (err) { throw err; }
                    });
                });
            });
        });
    });
}

// Handle a 'push' webhook.
function handleGithubPush(req, res, state) {
    var db = assert(state.db);
    var github = assert(state.github);
    var trustedAuthors = assert(state.githubTrustedAuthors);
    var allowedRepos = assert(state.githubRepos);

    // Careful to avoid automatic test runs unless repo/author is
    // whitelisted.

    var body = req.body;
    var commitHash = body.after;
    var committerName = body.head_commit && body.head_commit.committer && body.head_commit.committer.username;
    var repoName = body.repository && body.repository.name;
    var repoFullName = body.repository && body.repository.full_name;
    var ref = body.ref;
    if (!repoFullName || !repoName) {
        console.log('ignoring github webhook "push", missing repo name');
        return;
    }
    if (trustedAuthors.indexOf(committerName) < 0) {
        console.log('ignoring github webhook "push" from untrusted committer: ' + committerName);
        return;
    }
    if (allowedRepos.indexOf(repoFullName) < 0) {
        console.log('ignoring github webhook "push" for non-allowed repo: ' + repoFullName);
        return;
    }
    if (ref !== 'refs/heads/master') {
        // XXX: hardcoded for now
        console.log('ignoring github webhook "push" for non-master ref: ' + ref);
        return;
    }

    console.log('github webhook "push" to repo ' + repoFullName + ' from trusted committer ' + committerName + ', add automatic jobs');

    // XXX: add a commit_simple UUID for exact matching for get/finish?

    // Tracking object for commit related simple test runs identified by
    // run name, with 'runs' tracking the individual runs and their status.
    // A named run maps directly to a Github status item.

    // FIXME: prevent duplicate insert here
    db.insert({
        type: 'commit_simple',
        time: Date.now(),
        runs: [],
        repo: repoName,
        repo_full: repoFullName,
        repo_clone_url: assert(body.repository.clone_url),
        committer: committerName,
        sha: assert(commitHash)
    });

    // XXX: generalize and hide sibling access
    require('./commitutil').handleGetCommitRequests(state);
}

// Handle a 'pull_request' webhook.
function handleGithubPullRequest(req, res, state) {
    var db = assert(state.db);
    var github = assert(state.github);
    var trustedAuthors = assert(state.githubTrustedAuthors);
    var allowedRepos = assert(state.githubRepos);

    var body = req.body;
    if (body.action !== 'opened' && body.action !== 'synchronize') {
        console.log('ignoring github webhook "pull_request", based on action: ' + body.action);
        return;
    }
    if (typeof body.number !== 'number') {
        console.log('ignoring github webhook "pull_request", missing number');
        return;
    }

    var commitHash = body.after || body.pull_request && body.pull_request.head && body.pull_request.head.sha;
    var senderName = body.sender && body.sender.login;
    if (!senderName) {
        console.log('ignoring github webhook "pull_request", missing sender name');
        return;
    }
    var pullRequestUserName = body.pull_request && body.pull_request.user && body.pull_request.user.login;
    if (!pullRequestUserName) {
        console.log('ignoring github webhook "pull_request", missing pull request user name');
        return;
    }
    var repoName = body.repository && body.repository.name;
    var repoFullName = body.repository && body.repository.full_name;
    if (!repoFullName || !repoName) {
        console.log('ignoring github webhook "pull_request", missing repo name');
        return;
    }
    if (trustedAuthors.indexOf(senderName) < 0 || trustedAuthors.indexOf(pullRequestUserName) < 0) {
        console.log('ignoring github webhook "pull_request" from untrusted source: ' + senderName + ';' + pullRequestUserName);
        return;
    }
    if (allowedRepos.indexOf(repoFullName) < 0) {
        console.log('ignoring github webhook "pull_request" for non-allowed repo: ' + repoFullName);
        return;
    }

    console.log('github webhook "pull_request" to repo ' + repoFullName + ' commit ' + commitHash +
                ' from trusted source ' + senderName + ';' + pullRequestUserName + ', add automatic jobs');

    // XXX: add a commit_simple UUID for exact matching for get/finish?

    // FIXME: prevent duplicate insert here
    db.insert({
        type: 'commit_simple',
        time: Date.now(),
        runs: [],
        repo: repoName,
        repo_full: repoFullName,
        repo_clone_url: assert(body.repository.clone_url),
        sender: senderName,
        pullRequestUser: pullRequestUserName,
        fetch_ref: '+refs/pull/' + body.number + '/head',
        sha: assert(commitHash)
    });

    // XXX: generalize and hide sibling access
    require('./commitutil').handleGetCommitRequests(state);
}

// Create a github-webhook handler.
function makeGithubWebhookHandler(state) {
    var db = assert(state.db);
    var github = assert(state.github);

    return function githubWebhookHandler(req, res) {
        var body = req.body;
        if (typeof body !== 'object') {
           throw new Error('invalid POST body, perhaps client is missing Content-Type?');
        }
        var ghEvent = req.get('X-Github-Event');
        var ghDelivery = req.get('X-Github-Delivery');

        console.log('github webhook, event: ' + ghEvent + ', delivery: ' + ghDelivery);

        // Raw record of webhook requests received.
        db.insert({
            type: 'github_webhook',
            x_github_event: ghEvent,
            x_github_delivery: ghDelivery,
            data: assert(body)
        });

        if (ghEvent === 'push') {
            handleGithubPush(req, res, state);
        } else if (ghEvent === 'pull_request') {
            handleGithubPullRequest(req, res, state);
        } else {
            console.log('unhandled github webhook: ' + ghEvent);
        }

        var rep = {};
        // FIXME: sendJsonReply?
        var repData = new Buffer(JSON.stringify(rep), 'utf8');
        res.setHeader('content-type', 'application/json');
        res.send(repData);
    };
}

exports.makeGithubWebhookHandler = makeGithubWebhookHandler;
exports.createGithubStatus = createGithubStatus;
exports.updateGithubStatus = updateGithubStatus;
exports.pushGithubStatuses = pushGithubStatuses;
