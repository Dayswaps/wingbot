/*
 * @author David Menger
 */
'use strict';

const sinon = require('sinon');
const assert = require('assert');
const { Tester, ai } = require('../index');
const BuildRouter = require('../src/BuildRouter');
const Plugins = require('../src/Plugins');
const testbot = require('./testbot.json');

describe('<BuildRouter>', async () => {

    it('should behave as router', async () => {
        const plugins = new Plugins();

        plugins.code('exampleBlock', async (req, res) => {
            await res.run('responseBlockName');
        });

        const bot = BuildRouter.fromData(testbot.data, plugins);

        const t = new Tester(bot);

        await t.postBack('/start');

        t.passedAction('start');

        t.any()
            .genericTemplate(2)
            .contains('This is the first time, you\'re here')
            .attachmentType('image');

        await t.postBack('/start');

        t.passedAction('start');

        t.any()
            .contains('This is your 1 visit')
            .quickReplyAction('subblock-include')
            .contains('Welcome in the bot');

        await t.quickReply('subblock-include');

        t.passedAction('subblock-include');

        t.any()
            .buttonTemplate('text', 3)
            .contains('Want continue?')
            .quickReplyAction('back');

        await t.quickReply('back');

        t.passedAction('back');
        t.passedAction('continued-action');

        t.any()
            .contains('Lets try to go deeper')
            .quickReplyAction('deep-entrypoint');

        await t.quickReply('deep-entrypoint');

        t.passedAction('deep-entrypoint');

        t.any()
            .contains('Can go outside')
            .quickReplyAction('back');

        await t.quickReply('back');

        t.passedAction('back');
        t.passedAction('continued-action');

        await t.postBack('subblock-include');

        t.passedAction('subblock-include');

        ai.mockIntent('localIntent');

        await t.text('anytext');

        t.any().contains('This is local AI reaction');

        ai.mockIntent();
    });

    it('should return translated messages', async () => {
        const plugins = new Plugins();

        plugins.code('exampleBlock', async (req, res) => {
            await res.run('responseBlockName');
        });

        const bot = BuildRouter.fromData(testbot.data, plugins);

        const t = new Tester(bot);

        t.setState({ lang: 'cz' });

        await t.postBack('/start');

        t.passedAction('start');

        t.any()
            .contains('To je poprvé')
            .contains('This is fallback response')
            .contains('Správná odpověď');

    });

    function makeBot (text) {
        return {
            blocks: [{
                isRoot: true,
                routes: [{
                    path: '/start',
                    resolvers: [{
                        type: 'botbuild.message',
                        params: {
                            conditionFn: '(req, res) => { return new Promise(r => setTimeout(() => r(true), 100)); }',
                            replies: [],
                            text,
                            hasCondition: true
                        }
                    }]
                }]
            }]
        };
    }

    function wait (ms) { return new Promise(r => setTimeout(r, ms)); }

    describe('#reduce()', () => {

        let bot;
        let mockRequest;

        beforeEach(() => {
            const plugins = new Plugins();

            // lets mock the storage
            const configStorage = {
                ts: 0,
                cfg: null,
                async invalidateConfig () { this.ts = 0; this.cfg = null; },
                async getConfigTimestamp () { return this.ts; },
                async updateConfig (c) {
                    this.cfg = c;
                    const timestamp = Date.now();
                    this.ts = timestamp;
                    return Object.assign(c, { timestamp });
                },
                async getConfig () { return this.cfg; }
            };

            const config = { configStorage };

            let cnt = 0;

            mockRequest = sinon.spy(async () => {
                switch (cnt++) {
                    case 0:
                        return makeBot('first');
                    case 1:
                        return makeBot('second');
                    default:
                        throw new Error('Can be trigged only twice');
                }
            });

            bot = new BuildRouter({ botId: 'fake-bot-id' }, plugins, config, mockRequest);

            bot.keepConfigFor = -5000;
        });

        it('should load new configuration from the internet, other requests are waiting', async () => {
            // for two different users to be able to make simultaneous requests
            const testers = [new Tester(bot), new Tester(bot), new Tester(bot)];

            await Promise.all(testers.map(t => t.postBack('/start')));

            testers.forEach(t => t.res(0).contains('first'));

            assert.strictEqual(mockRequest.callCount, 1);

            await Promise.all(testers.map(t => t.postBack('/start')));

            testers.forEach(t => t.res(0).contains('first'));

            assert.strictEqual(mockRequest.callCount, 1);
        });

        it('should not update configuration, when requests are pending', async () => {
            const first = new Tester(bot);
            const second = new Tester(bot);
            const third = new Tester(bot);

            const firstPromise = first.postBack('/start');

            await wait(10);

            assert.strictEqual(bot._runningReqs.length, 1, 'the request has to be running');
            assert.strictEqual(mockRequest.callCount, 1, 'the config should be already downloaded');

            // lets invalidate the storage and run second request

            await bot._configStorage.invalidateConfig();

            await Promise.all([
                firstPromise,
                second.postBack('/start'),
                third.postBack('start')
            ]);

            assert.strictEqual(mockRequest.callCount, 2, 'the config should be downloaded again');

            first.res(0).contains('first');
            second.res(0).contains('second');
            third.res(0).contains('second');

        });

        it('should load first configuration from storage, when possible', async () => {
            const t = new Tester(bot);

            await bot._configStorage.updateConfig(makeBot('foo'));

            await t.postBack('/start');

            assert.strictEqual(bot._runningReqs.length, 0, 'the request has to be running');
            t.res(0).contains('foo');
        });
    });

});
