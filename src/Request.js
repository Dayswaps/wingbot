/*
 * @author David Menger
 */
'use strict';

const { tokenize, quickReplyAction, parseActionPayload } = require('./utils');

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * @typedef {Object} Intent
 * @prop {string} intent
 * @prop {number} score
 * @prop {Object[]} [entities]
 */

/**
 * Instance of {Request} class is passed as first parameter of handler (req)
 *
 * @class
 */
class Request {

    constructor (data, state, pageId) {
        this.data = data;

        this.message = data.message || null;

        this._postback = data.postback || null;

        this._referral = (this._postback && this._postback.referral)
            || data.referral
            || null;

        this._optin = data.optin || null;

        this.attachments = (data.message && data.message.attachments) || [];

        /**
         * @prop {number|null}
         */
        this.timestamp = data.timestamp || Date.now();

        /**
         * @prop {string} senderId sender.id from the event
         */
        this.senderId = (data.sender && data.sender.id) || null;

        /**
         * @prop {string} recipientId recipient.id from the event
         */
        this.recipientId = data.recipient && data.recipient.id;

        /**
         * @prop {string} pageId page identifier from the event
         */
        this.pageId = pageId;

        /**
         * @prop {Object} state current state of the conversation
         */
        this.state = state;

        this._intents = null;
    }

    /**
     * Returns intent, when using AI
     *
     * @param {boolean|number} getDataOrScore - score limit or true for getting intent data
     * @returns {null|string|Intent}
     */
    intent (getDataOrScore = false) {
        if (!this._intents || this._intents.length === 0) {
            return null;
        }

        const [intent] = this._intents;

        if (typeof getDataOrScore === 'number') {
            return intent.score >= getDataOrScore
                ? intent.intent
                : null;
        } else if (getDataOrScore) {
            return intent;
        }
        return intent.intent;
    }

    /**
     * Checks, when message contains an attachment (file, image or location)
     *
     * @returns {boolean}
     */
    isAttachment () {
        return this.attachments.length > 0;
    }

    _checkAttachmentType (type, attachmentIndex = 0) {
        if (this.attachments.length <= attachmentIndex) {
            return false;
        }
        return this.attachments[attachmentIndex].type === type;
    }

    /**
     * Checks, when the attachment is an image
     *
     * @param {number} [attachmentIndex=0] - use, when user sends more then one attachment
     * @returns {boolean}
     */
    isImage (attachmentIndex = 0) {
        return this._checkAttachmentType('image', attachmentIndex);
    }

    /**
     * Checks, when the attachment is a file
     *
     * @param {number} [attachmentIndex=0] - use, when user sends more then one attachment
     * @returns {boolean}
     */
    isFile (attachmentIndex = 0) {
        return this._checkAttachmentType('file', attachmentIndex);
    }

    /**
     * Checks for location in attachments
     *
     * @returns {boolean}
     */
    hasLocation () {
        return this.attachments.some(at => at.type === 'location');
    }

    /**
     * Gets location coordinates from attachment, when exists
     *
     * @returns {null|{lat:number,long:number}}
     *
     * @example
     * const { Router } = require('wingbot');
     *
     * const bot = new Router();
     *
     * bot.use('start', (req, res) => {
     *     res.text('share location?', [
     *         // location share quick reply
     *         { action: 'locAction', title: 'Share location', isLocation: true }
     *     ]);
     * });
     *
     * bot.use('locAction', (req, res) => {
     *     if (req.hasLocation()) {
     *         const { lat, long } = req.getLocation();
     *         res.text(`Got ${lat}, ${long}`);
     *     } else {
     *         res.text('No location received');
     *     }
     * });
     */
    getLocation () {
        const location = this.attachments.find(at => at.type === 'location');

        if (!location) {
            return null;
        }

        return location.payload.coordinates;
    }

    /**
     * Returns whole attachment or null
     *
     * @param {number} [attachmentIndex=0] - use, when user sends more then one attachment
     * @returns {Object|null}
     */
    attachment (attachmentIndex = 0) {
        if (this.attachments.length <= attachmentIndex) {
            return null;
        }
        return this.attachments[attachmentIndex];
    }

    /**
     * Returns attachment URL
     *
     * @param {number} [attachmentIndex=0] - use, when user sends more then one attachment
     * @returns {string|null}
     */
    attachmentUrl (attachmentIndex = 0) {
        if (this.attachments.length <= attachmentIndex) {
            return null;
        }
        const { payload } = this.attachments[attachmentIndex];
        if (!payload) {
            return null;
        }
        return payload && payload.url;
    }

    /**
     * Returns true, when the request is text message, quick reply or attachment
     *
     * @returns {boolean}
     */
    isMessage () {
        return this.message !== null;
    }

    /**
     * Check, that message is a quick reply
     *
     * @returns {boolean}
     */
    isQuickReply () {
        return this.message !== null && this.message.quick_reply;
    }

    /**
     * Check, that message is PURE text
     *
     * @returns {boolean}
     */
    isText () {
        return this.message !== null
            && !this.message.quick_reply
            && !!this.message.text;
    }

    /**
     * Returns text of the message
     *
     * @param {boolean} [tokenized=false] - when true, message is normalized to lowercase with `-`
     * @returns {string}
     *
     * @example
     * console.log(req.text(true)) // "can-you-help-me"
     */
    text (tokenized = false) {
        if (this.message === null) {
            return '';
        }

        if (tokenized && this.message.text) {
            return tokenize(this.message.text);
        }

        return this.message.text || '';
    }

    /**
     * Returns the request expected handler in case have been set last response
     *
     * @returns {string|null}
     */
    expected () {
        return this.state._expected || null;
    }

    /**
     * Returns action or data of quick reply
     * When `getData` is `true`, object will be returned. Otherwise string or null.
     *
     * @param {boolean} [getData=false]
     * @returns {null|string|Object}
     *
     * @example
     * typeof res.quickReply() === 'string' || res.quickReply() === null;
     * typeof res.quickReply(true) === 'object';
     */
    quickReply (getData = false) {
        if (this.message === null
            || !this.message.quick_reply) {
            return null;
        }

        return this._processPayload(this.message.quick_reply, getData);
    }

    /**
     * Returns true, if request is the postback
     *
     * @returns {boolean}
     */
    isPostBack () {
        return this._postback !== null;
    }

    /**
     * Returns true, if request is the referral
     *
     * @returns {boolean}
     */
    isReferral () {
        return this._referral !== null;
    }

    /**
     * Returns true, if request pass thread control
     *
     * @returns {boolean}
     */
    isPassThread () {
        return this.data.target_app_id || this.data.pass_thread_control;
    }

    /**
     * Returns true, if request is the optin
     *
     * @returns {boolean}
     */
    isOptin () {
        return this._optin !== null;
    }

    /**
     * Returns action of the postback or quickreply
     * When `getData` is `true`, object will be returned. Otherwise string or null.
     *
     * 1. the postback is checked
     * 2. the referral is checked
     * 3. the quick reply is checked
     * 4. expected keywords are checked
     * 5. expected state is checked
     *
     * @param {boolean} [getData=false]
     * @returns {null|string|Object}
     *
     * @example
     * typeof res.action() === 'string' || res.action() === null;
     * typeof res.action(true) === 'object';
     */
    action (getData = false) {
        let res = null;

        if (this._referral !== null && this._referral.ref) {
            res = this._processPayload({ payload: this._referral.ref }, getData);
        }

        if (!res && this._postback !== null) {
            res = this._processPayload(this._postback, getData);
        }

        if (!res && this._optin !== null && this._optin.ref) {
            res = this._base64Ref(this._optin, getData);
        }

        if (!res && this.message !== null && this.message.quick_reply) {
            res = this._processPayload(this.message.quick_reply, getData);
        }

        if (!res && this.isPassThread()) {
            if (this.data.pass_thread_control.metadata) {
                const payload = this.data.pass_thread_control.metadata;
                res = this._processPayload({ payload }, getData);
            }
            if (!getData && !res) {
                res = 'pass-thread';
            }
        }

        if (!res && this.state._expectedKeywords) {
            res = this._actionByExpectedKeywords(getData);
        }

        if (!res && this.state._expected) {
            res = this._processPayload(this.state._expected, getData);
        }

        if (getData) {
            return res || {};
        }

        return res || null;
    }

    _actionByExpectedKeywords (getData = false) {
        let res = null;

        if (!res && this.state._expectedKeywords) {
            const payload = quickReplyAction(
                this.state._expectedKeywords,
                this.text(true),
                this.text()
            );
            if (payload) {
                res = this._processPayload(payload, getData);
            }
        }

        return res;
    }

    /**
     * Returns action or data of postback
     * When `getData` is `true`, object will be returned. Otherwise string or null.
     *
     * @param {boolean} [getData=false]
     * @returns {null|string|Object}
     *
     * @example
     * typeof res.postBack() === 'string' || res.postBack() === null;
     * typeof res.postBack(true) === 'object';
     */
    postBack (getData = false) {
        if (this._postback === null) {
            return null;
        }
        return this._processPayload(this._postback, getData);
    }

    _base64Ref (object = {}, getData = false) {
        let process = {};

        if (object && object.ref) {
            let payload = object.ref;

            if (typeof payload === 'string' && payload.match(BASE64_REGEX)) {
                payload = Buffer.from(payload, 'base64').toString('utf8');
            }

            process = { payload };
        }

        return this._processPayload(process, getData);
    }

    _processPayload (object = {}, getData = false) {
        if (getData) {
            const { data } = parseActionPayload(object);
            return data;
        }

        const { action } = parseActionPayload(object);
        return action;
    }

}

function createReferral (action, data = {}, timestamp = Request.timestamp()) {
    return {
        timestamp,
        ref: JSON.stringify({
            action,
            data
        }),
        source: 'SHORTLINK',
        type: 'OPEN_THREAD'
    };
}

Request._t = 0;
Request._d = 0;

Request.timestamp = function () {
    let now = Date.now();
    if (now > Request._d) {
        Request._t = 0;
    } else {
        now += ++Request._t;
    }
    Request._d = now;
    return now;
};

Request.postBack = function (
    senderId,
    action,
    data = {},
    refAction = null,
    refData = {},
    timestamp = Request.timestamp()
) {
    const postback = {
        payload: {
            action,
            data
        }
    };
    if (refAction) {
        Object.assign(postback, {
            referral: createReferral(refAction, refData, timestamp)
        });
    }
    return {
        timestamp,
        sender: {
            id: senderId
        },
        postback
    };
};

Request.text = function (senderId, text, timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        message: {
            text
        }
    };
};

Request.passThread = function (senderId, newAppId, data = null, timestamp = Request.timestamp()) {
    let metadata = data;
    if (data !== null && typeof data !== 'string') {
        metadata = JSON.stringify(data);
    }
    return {
        timestamp,
        sender: {
            id: senderId
        },
        pass_thread_control: {
            new_owner_app_id: newAppId,
            metadata
        }
    };
};

Request.intent = function (senderId, text, intent, timestamp = Request.timestamp()) {
    const res = Request.text(senderId, text, timestamp);

    Object.assign(res, { intent });

    return res;
};

Request.quickReply = function (senderId, action, data = {}, timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        message: {
            text: action,
            quick_reply: {
                payload: JSON.stringify({
                    action,
                    data
                })
            }
        }
    };
};

Request.quickReplyText = function (senderId, text, payload, timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        message: {
            text,
            quick_reply: {
                payload
            }
        }
    };
};

Request.location = function (senderId, lat, long, timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        message: {
            attachments: [{
                type: 'location',
                payload: {
                    coordinates: { lat, long }
                }
            }]
        }
    };
};

Request.referral = function (senderId, action, data = {}, timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        referral: createReferral(action, data, timestamp)
    };
};

Request.optin = function (userRef, action, data = {}, timestamp = Request.timestamp()) {
    const ref = Buffer.from(JSON.stringify({
        action,
        data
    }));
    return {
        timestamp,
        optin: {
            ref: ref.toString('base64'),
            user_ref: userRef
        }
    };
};

Request.fileAttachment = function (senderId, url, type = 'file', timestamp = Request.timestamp()) {
    return {
        timestamp,
        sender: {
            id: senderId
        },
        message: {
            attachments: [{
                type,
                payload: {
                    url
                }
            }]
        }
    };
};


module.exports = Request;
