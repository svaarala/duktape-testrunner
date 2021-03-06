/*
 *  Testrunner server.
 */

var fs = require('fs');
var yaml = require('yamljs');
var express = require('express');
var bodyParser = require('body-parser');
var https = require('https');
var GitHubApi = require('github');
var Promise = require('bluebird');
var RateLimiter = require('limiter').RateLimiter;

var util = require('./util');
var assert = util.assert;
var expressutil = require('./expressutil');
var dbutil = require('./dbutil');
var githubutil = require('./githubutil');
var commitutil = require('./commitutil');
var webuiutil = require('./webuiutil');

function initDatabase(state) {
    return new Promise(function (resolve, reject) {
        console.log('Initialize MongoDB datastore: ' + state.databaseUri);
        var MongoClient = require('mongodb').MongoClient;
        MongoClient.connect(assert(state.databaseUri), function(err, db) {
            if (err) {
                reject(err);
            } else {
                var c = db.collection(assert(state.databaseCollection));
                console.log('Database connection OK, using collection: ' + state.databaseCollection);
                resolve(c);
            }
        });
    });
}

function main() {
    var state;

    return Promise.resolve().then(function () {
        console.log('Duktape testrunner server');

        // Parse args and config, initialize a shared 'state' object.
        var argv = require('minimist')(process.argv.slice(2));
        console.log('Command line options: ' + JSON.stringify(argv));
        var configFile = argv.config || './config.yaml';
        console.log('Load config: ' + configFile);
        state = yaml.load(configFile);
    }).then(function () {
        // Datastore init.
        return initDatabase(state).then(function (db) {
            state.db = db;
        });
    }).then(function () {
        // Github API instance.
        var github = new GitHubApi({
            version: '3.0.0',
            debug: false,
            protocol: 'https',
            host: 'api.github.com',
            timeout: 5000,
            header: {
                'user-agent': 'duktape-testrunner'
            }
        });
        state.github = github;
        state.githubLimiter = new RateLimiter(assert(state.githubTokensPerHour), 'hour', true);  // sanity limit
    }).then(function () {
        // Express and shared helpers.
        var app = express();
        var apiJsonBodyParser = expressutil.makeApiJsonBodyParser();
        var githubJsonBodyParser = expressutil.makeGithubJsonBodyParser(state.githubWebhookSecret);
        var apiBasicAuth = expressutil.makeApiBasicAuth(state.clientAuthUsername, state.clientAuthPassword, state.serverAuthPassword);
        var logRequest = expressutil.makeLogRequest();

        // URI paths served.
        app.get('/', logRequest,
                webuiutil.makeIndexHandler(state));
        app.get('/out/:sha', logRequest,
                webuiutil.makeDataFileHandler(state));
        app.post('/github-webhook', logRequest, githubJsonBodyParser,
                 githubutil.makeGithubWebhookHandler(state));
        app.post('/get-commit-simple', logRequest, apiBasicAuth, apiJsonBodyParser,
                 commitutil.makeGetCommitSimpleHandler(state));
        app.post('/accept-commit-simple', logRequest, apiBasicAuth, apiJsonBodyParser,
                 commitutil.makeAcceptCommitSimpleHandler(state));
        app.post('/finish-commit-simple', logRequest, apiBasicAuth, apiJsonBodyParser,
                 commitutil.makeFinishCommitSimpleHandler(state));
        app.post('/query-commit-simple', logRequest, apiBasicAuth, apiJsonBodyParser,
                 commitutil.makeQueryCommitSimpleHandler(state));

        // HTTPS server.
        var apiServer = https.createServer({
            key: fs.readFileSync(state.serverPrivateKey),
            cert: fs.readFileSync(state.serverCertificate)
        }, app);
        apiServer.listen(state.serverPort, function () {
            var host = apiServer.address().address;
            var port = apiServer.address().port;
            console.log('Duktape testrunner server listening at https://%s:%s', host, port);
        });

        // Short interval background job for hanging request timeouts, persistent
        // Github pushes, etc.
        function shortPeriodicDatabaseScan() {
            githubutil.pushGithubStatuses(state);       // persistent github status pushing
            commitutil.handleGetCommitRequests(state);  // webhook client timeouts
        }
        var shortDbScanTimer = setInterval(shortPeriodicDatabaseScan, 5 * 1000);

        // Long interval background job for detecting timed out jobs, etc.
        function longPeriodicDatabaseScan() {
            console.log('long periodic database scan');
            commitutil.handleAutoFailPending(state);    // autofail too old pending runs
        }
        var longDbScanTimer = setInterval(longPeriodicDatabaseScan, 3600 * 1000);
        setTimeout(longPeriodicDatabaseScan, 1000);  // run once right away
    });
}

main().catch(function (err) {
    console.error(err.stack || err);
    process.exit(1);
});

process.on('uncaughtException', function (err) {
    console.error(err.stack || err);
    process.exit(1);
});

process.on('unhandledRejection', function (reason, p) {
    console.error(reason, 'unhandled rejection for Promise:', p);
});
