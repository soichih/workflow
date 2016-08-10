'use strict';

//contrib
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var common = require('./common');

exports.select = function(user, query, cb) {
    //select all resource available for the user and active
    logger.debug("resource.select with query");
    logger.debug(query);
    logger.debug("user id / groups");
    logger.debug(user);
    db.Resource.find({
        //assume user always has gids set..
        "$or": [
            {user_id: user.sub},
            {gids: {"$in": user.gids }},
        ],
        status: 'ok', 
        active: true,
    })
    .exec(function(err, resources) {
        if(err) return cb(err);
        if(resources.length == 0) logger.warn("user:"+user.sub+" has no resource instance");
        if(query.preferred_resource_id) logger.info("user preferred_resource_id:"+query.preferred_resource_id);

        //select the best resource based on the query
        var best = null;
        var best_score = null;
        resources.forEach(function(resource) {
            var score = score_resource(resource, query);
            logger.debug("scoring "+resource._id+" type:"+resource.type+" score="+score);
            if(score == 0) return;
            if(!best || score > best_score) {
                //normally pick the best score...
                best_score = score;
                best = resource;
            } else if(score == best_score && 
                query.preferred_resource_id && 
                query.preferred_resource_id == resource._id.toString()) {
                //but if score ties, give user preference into consideration
                logger.debug("using "+query.preferred_resource_id+" since score tied");
                best = resource; 
            }
        });

        //for debugging
        if(best) {
            logger.debug("best resource chosen:"+best._id);
            logger.debug(config.resources[best.resource_id]);
        } else {
            logger.debug("no resource matched query");
            logger.debug(query);
        } 
        cb(null, best, best_score);
    });
}

function score_resource(resource, query) {
    var resource_detail = config.resources[resource.resource_id];
    //logger.debug(resource_detail);
    //see if resource supports the service
    //TODO other things we could do..
    //1... handle query.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    //3... take resource utilization into account (pick least used docker host, for example)
    if(!resource_detail) {
        logger.error("can't find resource detail for resource_id:"+resource.resource_id);
        return 0;
    }
    if(!resource_detail.services) {
        logger.error("resource detail for resource_id:"+resource.resource_id+" has no services entry");
        return 0;
    }
    var info = resource_detail.services[query.service];
    if(info === undefined) return 0;
    return info.score;
}

//run appropriate tests based on resource type
exports.check = function(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);
    if(detail.type === undefined) return cb(resource.resource_id+" doesn't have type defined.. don't know how to check");

    logger.debug(detail);
    switch(detail.type) {
    case "ssh":
        check_ssh(resource, update_status);
        break;
    default: 
        //update_status(null, "ok", "Don't know how to check "+resource.type + " .. assuming it to be ok");
        check_hpss(resource, update_status);
    }

    function update_status(err, status, msg) {
        if(err) return cb(err);
        logger.info("status:"+status+" msg:"+msg);
        resource.status = status;
        resource.status_msg = msg;
        resource.status_update = new Date();
        resource.save(function(err) {
            cb(err, {status: status, message: msg});
        });
    }
}

function check_hpss(resource, cb) {
    //find best resource to run hpss
    common.ls_hpss(resource, "./", function(err, files) {
        if(err) return cb(null, "failed", err.toString());
        cb(null, "ok", "hsi/ls returned "+files.length+" files on home directory");
    });
}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_ssh(resource, cb) {
    var conn = new Client();
    var ready = false;
    var nexted = false;
    conn.on('ready', function() {
        ready = true;
        conn.exec('whoami', function(err, stream) {
            if (err) {
                conn.end();
                nexted = true;
                return cb(err);
            }
            var ret_username = "";
            stream.on('close', function(code, signal) {
                //conn.end();
                nexted = true;
                if(ret_username.trim() == resource.config.username) {
                    check_sftp(resource, conn, function(err, status, msg) {
                        console.log("check_sftp cb -------------------------- "+resource._id);
                        conn.end();
                        if(err) return cb(err);
                        cb(null, status, msg);
                    });
                } else {
                    conn.end();
                    //TODO does it really matter that whois reports a wrong user?
                    cb(null, "ok", "ssh connection good but whoami reports:"+ret_username+" which is different from "+resource.config.username); 
                }
            }).on('data', function(data) {
                ret_username += data;
            }).stderr.on('data', function(data) {
                logger.error('whoami error: ');
            });
        })
        //conn.end();
        //cb(null, "unnknown", "??");
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
        if(!ready && !nexted) cb(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
    });
    conn.on('error', function(err) {
        nexted = true;
        cb(null, "failed", err.toString());
    });
    common.decrypt_resource(resource);
    logger.debug("decrypted");
    //console.dir(resource);
    var detail = config.resources[resource.resource_id];
    try {
        conn.connect({
            host: detail.hostname,
            username: resource.config.username,
            privateKey: resource.config.enc_ssh_private,
        });
    } catch (err) {
        cb(null, "failed", err.toString());
    }
}

//make sure I can open sftp connection and access workdir
function check_sftp(resource, conn, cb) {
    var workdir = common.getworkdir(null, resource);
    conn.sftp(function(err, sftp) {
        if(err) return cb(err);
        //logger.debug("reading directory:"+workdir);
        /*
        var t = setTimeout(function() {
            t = null;
            cb(null, "failed", "workdir is inaccessible (timeout)");
        }, 5000);
        */
        //sftp.readdir(workdir, function(err, list) {
        sftp.readdir(workdir, function(err, list) {
            //if(t == null) return; //timeout already called
            if(err) {
                //console.log("failed to readdir:"+workdir);
                //maybe it doesn't exist yet.. try to create it
                sftp.opendir(workdir, function(err) {
                    if(err) return cb(err); //truely bad..
                    cb(null, "ok", "ssh connection is good and workdir is accessible (created)");
                });
            }
            //clearTimeout(t);
            cb(null, "ok", "ssh connection is good and workdir is accessible");
        });
    });
}
