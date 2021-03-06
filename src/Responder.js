/*
 * @author David Menger
 */
'use strict';

const util = require('util');
const ReceiptTemplate = require('./templates/ReceiptTemplate');
const ButtonTemplate = require('./templates/ButtonTemplate');
const GenericTemplate = require('./templates/GenericTemplate');
const ListTemplate = require('./templates/ListTemplate');
const { makeAbsolute, makeQuickReplies } = require('./utils');

const TYPE_RESPONSE = 'RESPONSE';
const TYPE_UPDATE = 'UPDATE';
const TYPE_MESSAGE_TAG = 'MESSAGE_TAG';

/**
 * Instance of responder is passed as second parameter of handler (res)
 *
 * @class
 */
class Responder {

    constructor (senderId, messageSender, token = null, options = {}, data = {}) {
        this._messageSender = messageSender;
        this._senderId = senderId;
        this.token = token;

        /**
         * The empty object, which is filled with res.setState() method
         * and saved (with Object.assign) at the end of event processing
         * into the conversation state.
         *
         * @prop {Object}
         */
        this.newState = {};

        this.path = '';
        this.routePath = '';

        this.options = {
            translator: w => w,
            appUrl: ''
        };

        Object.assign(this.options, options);
        if (this.options.autoTyping) {
            this.options.autoTyping = Object.assign({
                time: 450,
                perCharacters: 'Sample text Sample texts'.length,
                minTime: 400,
                maxTime: 1400
            }, this.options.autoTyping);
        }

        this._t = this.options.translator;

        this._quickReplyCollector = [];

        this._data = data;

        this._messagingType = TYPE_RESPONSE;

        this._tag = null;

        this._firstTypingSkipped = false;
    }

    _send (data) {
        if (!data.messagingType) {
            Object.assign(data, {
                messaging_type: this._messagingType
            });
        }

        if (!data.tag && this._tag) {
            Object.assign(data, {
                tag: this._tag
            });
        }

        this._messageSender.send(data);
    }

    /**
     *
     * @param {string} messagingType
     * @param {string} [tag]
     * @returns {this}
     */
    setMessgingType (messagingType, tag = null) {
        this._messagingType = messagingType;
        this._tag = tag;
        return this;
    }

    /**
     * Returns true, when responder is not sending an update (notification) message
     *
     * @returns {boolean}
     */
    isResponseType () {
        return this._messagingType === TYPE_RESPONSE;
    }

    /**
     * @type {Object}
     */
    get data () {
        return this._data;
    }

    /**
     * Set temporary data to responder, which are persisted through single event
     *
     * @param {Object} data
     * @returns {this}
     * @example
     *
     * bot.use('foo', (req, res, postBack) => {
     *     res.setData({ a: 1 });
     *     postBack('bar');
     * });
     *
     * bot.use('bar', (req, res) => {
     *     res.data.a; // === 1 from postback
     * });
     */
    setData (data) {
        Object.assign(this._data, data);
        return this;
    }

    setPath (absolutePath, routePath = '') {
        this.path = absolutePath;
        this.routePath = routePath;
    }

    /* eslint jsdoc/check-param-names: 0 */
    /**
     * Send text as a response
     *
     * @param {string} text - text to send to user, can contain placeholders (%s)
     * @param {...Object.<string, string>|Object[]} [quickReplies] - quick replies object
     * @returns {this}
     *
     * @example
     * // simply
     * res.text('Hello %s', name, {
     *     action: 'Quick reply',
     *     another: 'Another quick reply'
     * });
     *
     * // complex
     * res.text('Hello %s', name, [
     *     { action: 'action', title: 'Quick reply' },
     *     {
     *         action: 'complexAction', // required
     *         title: 'Another quick reply', // required
     *         match: 'string' || /regexp/, // optional
     *         someData: 'Will be included in payload data' // optional
     *     }
     * ]);
     */
    text (text, ...quickReplies) {
        const messageData = {
            recipient: {
                id: this._senderId
            },
            message: {
                text: null
            }
        };

        let replies = null;

        if (quickReplies.length > 0
            && typeof quickReplies[quickReplies.length - 1] === 'object'
            && quickReplies[quickReplies.length - 1] !== null) {

            replies = quickReplies.pop();
        }

        const translatedText = this._t(text);

        if (quickReplies.length > 0) {
            messageData.message.text = util.format(
                translatedText,
                // filter undefined and null values
                ...quickReplies.map(a => (a !== null && typeof a !== 'undefined' ? a : ''))
            );
        } else {
            messageData.message.text = translatedText;
        }

        if (replies || this._quickReplyCollector.length !== 0) {

            const { quickReplies: qrs, expectedKeywords }
                = makeQuickReplies(replies || [], this.path, this._t, this._quickReplyCollector);

            this._quickReplyCollector = [];

            messageData.message.quick_replies = qrs;
            this.setState({ _expectedKeywords: expectedKeywords });
        }

        this._autoTypingIfEnabled(messageData.message.text);
        this._send(messageData);
        return this;
    }
    /* eslint jsdoc/check-param-names: 1 */

    /**
     * Sets new attributes to state (with Object.assign())
     *
     * @param {Object} object
     * @returns {this}
     *
     * @example
     * res.setState({ visited: true });
     */
    setState (object) {
        Object.assign(this.newState, object);
        return this;
    }

    /**
     * Appends quick reply, to be sent with following text method
     *
     * @param {string} action - relative or absolute action
     * @param {string} title - quick reply title
     * @param {Object} [data] - additional data
     * @param {boolean} [prepend] - set true to add reply at the beginning
     * @example
     *
     * bot.use((req, res) => {
     *     res.addQuickReply('barAction', 'last action');
     *
     *     res.addQuickReply('theAction', 'first action', {}, true);
     *
     *     res.text('Text', {
     *         fooAction: 'goto foo'
     *     }); // will be merged and sent with previously added quick replies
     * });
     */
    addQuickReply (action, title, data = {}, prepend = false) {
        let prep = {};
        if (prepend) {
            prep = { _prepend: true };
        }
        this._quickReplyCollector.push(Object.assign({
            action: this.toAbsoluteAction(action),
            title
        }, data, prep));
        return this;
    }

    /**
     * When user writes some text as reply, it will be processed as action
     *
     * @param {string} action - desired action
     * @param {Object} data - desired action data
     * @returns {this}
     */
    expected (action, data = {}) {
        if (!action) {
            return this.setState({ _expected: null });
        }
        return this.setState({
            _expected: {
                action: makeAbsolute(action, this.path),
                data
            }
        });
    }

    /**
     * Converts relative action to absolute action path
     *
     * @param {string} action - relative action to covert to absolute
     * @returns {string} absolute action path
     */
    toAbsoluteAction (action) {
        return makeAbsolute(action, this.path);
    }

    /**
     * Sends image as response. Requires appUrl option to send images from server
     *
     * @param {string} imageUrl - relative or absolute url
     * @param {boolean} [reusable] - force facebook to cache image
     * @returns {this}
     *
     * @example
     * // image on same server (appUrl option)
     * res.image('/img/foo.png');
     *
     * // image at url
     * res.image('https://google.com/img/foo.png');
     */
    image (imageUrl, reusable = false) {
        this._attachment(imageUrl, 'image', reusable);
        return this;
    }

    /**
     * Sends video as response. Requires appUrl option to send videos from server
     *
     * @param {string} videoUrl - relative or absolute url
     * @param {boolean} [reusable] - force facebook to cache asset
     * @returns {this}
     *
     * @example
     * // file on same server (appUrl option)
     * res.video('/img/foo.mp4');
     *
     * // file at url
     * res.video('https://google.com/img/foo.mp4');
     */
    video (videoUrl, reusable = false) {
        this._attachment(videoUrl, 'video', reusable);
        return this;
    }

    /**
     * Sends file as response. Requires appUrl option to send files from server
     *
     * @param {string} fileUrl - relative or absolute url
     * @param {boolean} [reusable] - force facebook to cache asset
     * @returns {this}
     *
     * @example
     * // file on same server (appUrl option)
     * res.file('/img/foo.pdf');
     *
     * // file at url
     * res.file('https://google.com/img/foo.pdf');
     */
    file (fileUrl, reusable = false) {
        this._attachment(fileUrl, 'file', reusable);
        return this;
    }

    _attachment (attachmentUrl, type, reusable = false) {
        let url = attachmentUrl;

        if (!url.match(/^https?:\/\//)) {
            url = `${this.options.appUrl}${url}`;
        }

        const messageData = {
            recipient: {
                id: this._senderId
            },
            message: {
                attachment: {
                    type,
                    payload: {
                        url,
                        is_reusable: reusable
                    }
                }
            }
        };

        const autoTyping = reusable ? null : false;
        this._autoTypingIfEnabled(autoTyping);
        this._send(messageData);
        return this;
    }

    template (payload) {
        const messageData = {
            recipient: {
                id: this._senderId
            },
            message: {
                attachment: {
                    type: 'template',
                    payload
                }
            }
        };

        this._autoTypingIfEnabled(null);
        this._send(messageData);
        return this;
    }

    /**
     * Sets delay between two responses
     *
     * @param {number} [ms=600]
     * @returns {this}
     */
    wait (ms = 600) {
        this._send({ wait: ms });
        return this;
    }

    /**
     * Sends "typing..." information
     *
     * @returns {this}
     */
    typingOn () {
        this._senderAction('typing_on');
        return this;
    }

    /**
     * Stops "typing..." information
     *
     * @returns {this}
     */
    typingOff () {
        this._senderAction('typing_off');
        return this;
    }

    /**
     * Reports last message from user as seen
     *
     * @returns {this}
     */
    seen () {
        this._senderAction('mark_seen');
        return this;
    }

    /**
     * Pass thread to another app
     *
     * @param {string} targetAppId
     * @param {string|Object} [data]
     * @returns {this}
     */
    passThread (targetAppId, data = null) {
        let metadata = data;
        if (data !== null && typeof data !== 'string') {
            metadata = JSON.stringify(data);
        }
        const messageData = {
            recipient: {
                id: this._senderId
            },
            target_app_id: targetAppId,
            metadata
        };
        this._send(messageData);
        return this;
    }

    /**
     * Take thread from another app
     *
     * @param {string|Object} [data]
     * @returns {this}
     */
    takeThead (data = null) {
        let metadata = data;
        if (data !== null && typeof data !== 'string') {
            metadata = JSON.stringify(data);
        }
        const messageData = {
            recipient: {
                id: this._senderId
            },
            take_thread_control: {
                metadata
            }
        };
        this._send(messageData);
        return this;
    }

    /**
     * Sends Receipt template
     *
     * @param {string} recipientName
     * @param {string} [paymentMethod='Cash'] - should not contain more then 4 numbers
     * @param {string} [currency='USD'] - sets right currency
     * @param {string} [uniqueCode=null] - when omitted, will be generated randomly
     * @returns {ReceiptTemplate}
     *
     * @example
     * res.receipt('Name', 'Cash', 'CZK', '1')
     *     .addElement('Element name', 1, 2, '/inside.png', 'text')
     *     .send();
     */
    receipt (recipientName, paymentMethod = 'Cash', currency = 'USD', uniqueCode = null) {
        return new ReceiptTemplate(
            payload => this.template(payload),
            this._createContext(),
            recipientName,
            paymentMethod,
            currency,
            uniqueCode
        );
    }

    /**
     * Sends nice button template. It can redirect user to server with token in url
     *
     * @param {string} text
     * @returns {ButtonTemplate}
     *
     * @example
     * res.button('Hello')
     *     .postBackButton('Text', 'action')
     *     .urlButton('Url button', '/internal', true) // opens webview with token
     *     .urlButton('Other button', 'https://goo.gl') // opens in internal browser
     *     .send();
     */
    button (text) {
        const btn = new ButtonTemplate(
            payload => this.template(payload),
            this._createContext(),
            text
        );
        return btn;
    }

    /**
     * Creates a generic template
     *
     * @param {boolean} [shareable] - ability to share template
     * @param {boolean} [isSquare] - use square aspect ratio for images
     * @example
     * res.genericTemplate()
     *     .addElement('title', 'subtitle')
     *         .setElementImage('/local.png')
     *         .setElementAction('https://www.seznam.cz')
     *         .postBackButton('Button title', 'action', { actionData: 1 })
     *     .addElement('another', 'subtitle')
     *         .setElementImage('https://goo.gl/image.png')
     *         .setElementActionPostback('action', { actionData: 1 })
     *         .urlButton('Local link with extension', '/local/path', true, 'compact')
     *     .send();
     *
     * @returns {GenericTemplate}
     *
     */
    genericTemplate (shareable = false, isSquare = false) {
        return new GenericTemplate(
            payload => this.template(payload),
            this._createContext(),
            shareable,
            isSquare
        );
    }

    /**
     * Creates a generic template
     *
     * @example
     * res.list('compact')
     *     .postBackButton('Main button', 'action', { actionData: 1 })
     *     .addElement('title', 'subtitle')
     *         .setElementImage('/local.png')
     *         .setElementUrl('https://www.seznam.cz')
     *         .postBackButton('Button title', 'action', { actionData: 1 })
     *     .addElement('another', 'subtitle')
     *         .setElementImage('https://goo.gl/image.png')
     *         .setElementAction('action', { actionData: 1 })
     *         .urlButton('Local link with extension', '/local/path', true, 'compact')
     *     .send();
     *
     * @param {'large'|'compact'} [topElementStyle='large']
     * @returns {ListTemplate}
     */
    list (topElementStyle = 'large') {
        return new ListTemplate(
            topElementStyle,
            payload => this.template(payload),
            this._createContext()
        );
    }

    _senderAction (action) {
        const messageData = {
            recipient: {
                id: this._senderId
            },
            sender_action: action
        };

        this._send(messageData);
        return this;
    }

    _createContext () {
        const { translator, appUrl } = this.options;
        return {
            translator,
            appUrl,
            token: this.token || '',
            senderId: this._senderId,
            path: this.path
        };
    }

    _autoTypingIfEnabled (text) {
        if (!this.options.autoTyping) {
            return;
        }
        if (this._messagingType !== TYPE_RESPONSE && !this._firstTypingSkipped) {
            this._firstTypingSkipped = true;
            return;
        }
        const typingTime = this._getTypingTimeForText(text);
        this.typingOn().wait(typingTime);
    }

    _getTypingTimeForText (text) {
        if (text === false) {
            return 1;
        }

        const textLength = typeof text === 'string'
            ? text.length
            : this.options.autoTyping.perCharacters;

        const timePerCharacter = this.options.autoTyping.time
            / this.options.autoTyping.perCharacters;

        return Math.min(
            Math.max(
                textLength * timePerCharacter,
                this.options.autoTyping.minTime
            ),
            this.options.autoTyping.maxTime
        );
    }

}

Responder.TYPE_MESSAGE_TAG = TYPE_MESSAGE_TAG;
Responder.TYPE_UPDATE = TYPE_UPDATE;
Responder.TYPE_RESPONSE = TYPE_RESPONSE;

module.exports = Responder;
