'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');

function getinstance(instid, req, cb) {
    db.Instance
    .findById(instid)
    .exec(function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("404");
        if(req.user.sub != instance.user_id) return cb("401");
        cb(null, instance);
    });
}
 
/**
 * @api {get} /instance         Query Instance
 * @apiGroup                    Instance
 * @apiDescription              Query instances that belongs to a user with given query
 *
 * @apiParam {Object} [find]    Mongo find query JSON.stringify & encodeURIComponent-ed - defaults to {}
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {instances: [], count: 24}       List of instances (maybe limited / skipped) and total number of instances
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);

    //var sort = '_id';
    //if(req.query.sort) sort = JSON.parse(req.query.sort);

    find.user_id = req.user.sub;

    db.Instance.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .exec(function(err, instances) {
        if(err) return next(err);
        db.Instance.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({instances: instances, count: count});
        });
    });
});

//get a single workflow instance
router.get('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    getinstance(req.params.instid, req, function(err, instance) {
        if(err) return next(err);
        res.json(instance);
    });
});

/**
 * @api {put} /instance/:instid Update Instance
 * @apiGroup                    Instance
 * @apiDescription              Update Instance
 *
 * @apiParam {String} [name]    Name for this instance
 * @apiParam {String} [desc]    Description for this instance
 * @apiParam {Object} [config]  Configuration for this instance
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.put('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.instid;
    var name = req.body.name;
    var desc = req.body.desc;
    var config = req.body.config;
    db.Instance.update({_id: id, user_id: req.user.sub}, {$set: {
        name: name,
        desc: desc,
        config: config, 
        update_date: new Date(),
    }}, function(err, instance) {
        if(err) return next(err);
        res.json(instance);
        
        //also update name on instance progress
        var progress_key = common.create_progress_key(id);
        common.progress(progress_key, {name: instance.name||instance.workflow_id||instance._id});
    });
});

/**
 * @api {post} /instance        New Instance
 * @apiGroup                    Instance
 * @apiDescription              Create a new instance
 *
 * @apiParam {String} workflow_id Name of workflow that this instance belongs to (sca-wf-life)
 * @apiParam {String} name      Name of the instance
 * @apiParam {String} [desc]    Description of the instance
 * @apiParam {Object} [config]  Any information you'd like to associate with this instanace
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.post('/:workflowid?', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance = new db.Instance({});
    instance.workflow_id = req.body.workflow_id || req.params.workflowid; //params.workflowid is dreprecated
    instance.name = req.body.name;
    instance.desc = req.body.desc;
    instance.config = req.body.config;

    instance.user_id = req.user.sub;
    instance.save(function(err) {
        if(err) return next(err);
        res.json(instance);

        //set the name for the instance grouping in case use wants to display instance level progress detail
        var progress_key = common.create_progress_key(instance._id);
        common.progress(progress_key, {name: instance.name||instance.workflow_id||instance._id});
    });
});

module.exports = router;

