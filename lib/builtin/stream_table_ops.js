// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2015-2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const AsyncQueue = require('consumer-queue');

const { combineOutputTypes } = require('./output_type_ops');
const PrimitiveOps = require('./primitive_ops');
const equalityTest = PrimitiveOps.equality;

// Library helpers used by the compiled TT code

function tupleEquals(a, b, keys) {
    for (let key of keys) {
        if (!equalityTest(a[key], b[key]))
            return false;
    }
    return true;
}

function isNewTuple(state, tuple, keys) {
    if (state === null)
        return true;

    let tlast, tprevious;
    for (let i = state.length-1; i >= 0; i--) {
        if (tlast === undefined)
            tlast = state[i].__timestamp;
        else if (tprevious === undefined && state[i].__timestamp < tlast)
            tprevious = state[i].__timestamp;
        else if (state[i].__timestamp < tprevious)
            break;
    }
    if (tuple.__timestamp === tlast)
        tlast = tprevious;
    if (tlast === undefined)
        return true;

    for (let i = 0; i < state.length; i++) {
        if (state[i].__timestamp !== tlast)
            continue;
        if (tupleEquals(state[i], tuple, keys))
            return false;
    }
    return true;
}
module.exports.isNewTuple = isNewTuple;

function addTuple(state, tuple) {
    if (state === null)
        return [tuple];
    state.push(tuple);

    // trim the state to
    let tlast, tprevious;
    let i;
    for (i = state.length-1; i >= 0; i--) {
        if (tlast === undefined)
            tlast = state[i].__timestamp;
        else if (tprevious === undefined && state[i].__timestamp < tlast)
            tprevious = state[i].__timestamp;
        else if (state[i].__timestamp < tprevious)
            break;
    }
    if (i >= 0) {
        assert(state[i].__timestamp < tprevious);
        state = state.slice(i+1);
    }

    return state;
}
module.exports.addTuple = addTuple;

function streamUnion(lhs, rhs) {
    let queue = new AsyncQueue();

    let currentLeft = null;
    let currentRight = null;
    let doneLeft = false;
    let doneRight = false;
    function emit() {
        if (currentLeft === null || currentRight === null)
            return;
        let [leftType, leftValue] = currentLeft;
        let [rightType, rightValue] = currentRight;
        let newValue = {};
        Object.assign(newValue, leftValue);
        Object.assign(newValue, rightValue);
        let newType = combineOutputTypes(leftType, rightType);
        queue.push({ value: [newType, newValue], done: false });
    }
    function checkDone() {
        if (doneLeft && doneRight)
            queue.push({ done: true });
    }

    lhs((...v) => {
        currentLeft = v;
        emit();
    }).then(() => {
        doneLeft = true;
        checkDone();
    }).catch((err) => queue.cancelWait(err));

    rhs((...v) => {
        currentRight = v;
        emit();
    }).then(() => {
        doneRight = true;
        checkDone();
    }).catch((err) => queue.cancelWait(err));

    return queue;
}
module.exports.streamUnion = streamUnion;

function accumulateStream(stream) {
    let into = [];

    return stream((...v) => {
        into.push(v);
    }).then(() => into);
}

class DelayedIterator {
    constructor(promise) {
        this._promise = promise;
        this._iterator = null;
    }

    next() {
        if (this._iterator !== null)
            return Promise.resolve(this._iterator.next());
        return this._promise.then((iterator) => {
            this._iterator = iterator;
            return this._iterator.next();
        });
    }
}

function tableCrossJoin(lhs, rhs) {
    return new DelayedIterator(Promise.all([
        accumulateStream(lhs),
        accumulateStream(rhs)
    ]).then(([left, right]) => {
        return (function*() {
            for (let l of left) {
                for (let r of right) {
                    let [leftType, leftValue] = l;
                    let [rightType, rightValue] = r;
                    let newValue = {};
                    Object.assign(newValue, leftValue);
                    Object.assign(newValue, rightValue);
                    let newType = combineOutputTypes(leftType, rightType);
                    yield [newType, newValue];
                }
            }
        })();
    }));
}
module.exports.tableCrossJoin = tableCrossJoin;

function invokeStreamVarRef(env, varref, ...args) {
    let queue = new AsyncQueue();

    function emit(...value) {
        queue.push({ value, done: false });
    }
    varref(env, emit, ...args).then(() => {
        queue.push({ done: true });
    }).catch((err) => {
        queue.cancelWait(err);
    });

    return queue;
}
module.exports.invokeStreamVarRef = invokeStreamVarRef;
