/*
 *  Db utilities.
 */

var Promise = require('bluebird');

// Find document(s).
function find(db, arg) {
    return new Promise(function (resolve, reject) {
        db.find(arg).toArray(function (err, docs) {
            if (err) {
                reject(err);
            } else {
                resolve(docs);
            }
        });
    });
}

// Insert document.
function insertOne(db, arg) {
    return new Promise(function (resolve, reject) {
        db.insertOne(arg, {}, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

// Update one document.
function updateOne(db, filter, update) {
    return new Promise(function (resolve, reject) {
        db.updateOne(filter, update, {}, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

exports.insertOne = insertOne;
exports.updateOne = updateOne;
exports.find = find;
