==================
Duktape testrunner
==================

Overview
========

Duktape testrunner provides multi-platform client-server test execution
which is integrated with Github webhooks.  Current functionality:

* Accepting webhook POSTs from Github

* Managing the execution of a set of tests associated with commits
  ("push" and "pull_request" events) together with test clients; each test
  is a simple script with a textual output and a success/failure indication

* Integrating test execution status with Github status API

* Providing a placeholder web UI for showing pending tests

The main goals for the client-server model are:

* The ability of execute tests on a wide variety of platforms, including
  exotic platforms which have no emulators and sometimes no TCP/IP networking.

* Allow easy integration of simple test scripts to make it easy to extend test
  coverage incrementally.  For example, test scripts might include basic
  compile/test runs for some applications using Duktape.

At this point the functionality is very limited.

Server architecture
===================

The server is written in Node.js, using Express.js for the HTTP/HTTPS
interfaces to interface with Github, test clients, and for serving the
web UI.

A MongoDB database (previously NeDB) is used for persistent state.

There's some temporary RAM-based state for handling hanging requests, so that
they can be woken up on state changes.  This state is non-critical and doesn't
need to be persisted.

MongoDB conventions:

* Each document has a ``type`` field, with lowercase, underscore separated
  value identifying the document type.

* Keys are lowercase, underscore separated.

* Platform, architecture, compiler names, job types, etc. are lowercase and
  underscore separated too.

Simple commit jobs
==================

Basics
------

The term "simple commit job" refers (here) to a simple script based test run:

* A test run is associated with a repo/sha pair (where the commit hash is
  from a Github "push" webhook) and a named "context".  A fresh temporary
  directory (automatically cleaned up on exit) is created for each run.

* The "context" identifies the test type and maps to (1) a test script in the
  test client, and (2) a Github status line associated with the repo/sha pair.
  The status line is shown in the Github Web UI (similar to Travis CI).
  Example contexts:

  - "x64-qecmatest": maps to ``run_x64_qecmatest.sh`` in the test client.

  - "x64-apitest": maps to ``run_x64_apitest.sh``.

* Each test run ultimately produces a success/failure indication and some
  text associated with the test run.  The Github status line links to an
  URI provided by the test server, serving the text on demand.

Test scripts
------------

A test script can be implemented e.g. as a bash script:

* The script gets various arguments, including a clone URI, a full repo name,
  the commit hash, etc.

* The script clones the repo and checks out the commit hash, and runs the
  test.  As a practical optimization a full checkout should be avoided, e.g.
  as follows:

  - Clone the target repo and create a local tar.gz package of the clone.
    When running a test, unpack the tar.gz and ``git pull --rebase`` to get the
    latest changes.  This works even with parallel tests and minimizes Git
    pull traffic.

  - Keep the repo checkout and reuse it for the next run; ``git clean -f`` can
    be used to clean the repo for the next run.  This only works if there's
    no parallelism.

* Because the test script will be run without interaction, it must have the
  necessary credentials to clone repositories (but not commit to them).

Limitations
-----------

Simple commit jobs have many limitations, e.g. they don't parallelize well,
and the result feedback is sparse.  The main point is that new jobs are easy
to add, and easy to test independent of the testrunner infrastructure as the
actual test script can be e.g. a very simple bash script.  Existing tests in
the top level Makefile can also be easily added as simple commit jobs.

More complex test job models will be added later; for example, the full matrix
of Duktape versions, config options, testcases, platforms, and compilers could
be tracked with very small individual test runs.  This parallelizes much better
and merges the existing test suite and matrix test runs into one.  This needs
more state in the server and also requires a much more complicated test client
so the ability to add simple script jobs will still remain.

Testrunner API HTTPS conventions
================================

Conventions used for testrunner API calls.

HTTPS
-----

HTTPS with mutual authentication is used for all requests.  POST requests are
used for JSON-based API methods.  GET requests are used to both download JSON
data and arbitrary files like test log files (and in the future, Duktape
distributable packages, test cases, etc).

Proper authentication is important because test clients compile and execute
code provided by the test server, which is very easily exploitable using a
fake server.

Server authentication
---------------------

A self signed Duktape CA certificate is used as the client trust root.  The CA
keypair is used to sign the testrunner server certificate, forming a two level
hierarchy.  A single level hierarchy, i.e. direct trust on a self-signed server
certificate, seems to work poorly with existing libraries.  There's no subject
name validation.

``X-TestRunner-Authenticator`` header in responses provides some additional
security against a misconfigured client accidentally talking to a fake server.

Client authentication
---------------------

HTTP basic authentication, i.e. ``Authorization`` header is used for both
GET and POST requests.  Basic authentication is also easy to use from e.g.
``curl``.

POST request content
--------------------

POST request body is a JSON object.  Content-Type is ignored by server to
make it easier to write clients, but should be set to ``application/json``.

POST response content
---------------------

POST response body is a JSON object.  Content-Type is ``application/json``.

JSON conventions
----------------

Keys are lowercase and underscore separated, e.g. ``repo_full``.

Server always sends packed one-liner JSON but accepts arbitrary JSON.
Getting a single line JSON response makes it simpler for clients doing
ad hoc parsing instead of using an actual JSON parser.

Other naming conventions
------------------------

HTTP(S) method paths as lowercase, dash separated, e.g. ``/get-job``.

Error codes are uppercase and underscore separated, e.g. ``NO_JOBS``.

Github webhook HTTPS conventions
================================

Conventions used for inbound and outbound Github calls.

Client (Github) authentication
------------------------------

Github uses a ``X-Hub-Signature`` header in its POST requests, the value
being a HMAC-SHA1 of the POST body and a secret key.

Committer authorization
-----------------------

A pull request from a random third party poses a serious security risk for
the test clients because the test client will compile and run arbitrary C
code.  (Because the committer is known, an attack will be traceable however.)

For now, the testrunner will trigger automatic test runs only when the
commit being tested comes from a whitelisted list of trusted authors.  Other
webhooks are accepted but won't automatically trigger test runs.

Testrunner URIs
===============

URIs served by testrunner; these are not documented in detail here, see source
for details:

+-----------------------------+----------+----------------+--------------------------------------------------------+
| URI                         | Method   | Authentication | Description                                            |
+=============================+==========+================+========================================================+
| /index.html                 | GET      | none           | Web UI index page                                      |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /                           | GET      | none           | Web UI index page                                      |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /out/xxx                    | GET      | none           | Test run output files, named by data hash              |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /github-webhook             | POST     | Github         | Github webhook: https://developer.github.com/webhooks/ |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /get-commit-simple          | POST     | Testrunner     | Request a commit-related test for list of supported    |
|                             |          |                | contexts                                               |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /accept-commit-simple       | POST     | Testrunner     | Confirm that a commit-related test has been received   |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /finish-commit-simple       | POST     | Testrunner     | Finish a commit-related test for a context             |
+-----------------------------+----------+----------------+--------------------------------------------------------+
| /query-commit-simple        | POST     | Testrunner     | Query all result state for a repo + commit hash        |
+-----------------------------+----------+----------------+--------------------------------------------------------+

MongoDb document types
======================

These are not documented in detail here, see source for details:

+----------------------------+-------------------------------------------------------+
| Type                       | Description                                           |
+============================+=======================================================+
| ``github_status``          | Github status target, may be out-of-sync              |
+----------------------------+-------------------------------------------------------+
| ``github_webhook``         | Github webhook information                            |
+----------------------------+-------------------------------------------------------+
| ``commit_simple``          | State for simple tests related to a single commit     |
+----------------------------+-------------------------------------------------------+

Security considerations
=======================

Running test cases involves compiling and executing arbitrary C code on the
test target.  It's therefore quite dangerous to automatically execute tests
for all pull requests -- anyone can create pull requests and place arbitrary
code in them.

For now there are filters in place so that the test server only reacts to
webhook requests coming from trusted repositories / committers.

If the test client is properly sandboxed it would be possible to run tests
for pull requests from unknown sources.  Sandboxing would need to include
network filtering, backstop sanity timeouts, etc.

See similar discussion related to Travis secure environment variables:

* http://docs.travis-ci.com/user/pull-requests/#Security-Restrictions-when-testing-Pull-Requests

References
==========

* http://expressjs.com/

* https://github.com/louischatriot/nedb

* https://developer.github.com/webhooks/
