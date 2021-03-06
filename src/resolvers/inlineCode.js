/*
 * @author David Menger
 */
'use strict';

const { customFn } = require('./utils');

function inlineCode (params, { isLastIndex }) {
    const fn = customFn(params.code, params.description);

    return async function (req, res, postBack, path, action) {
        let ret = fn(req, res, postBack, path, action);

        if (typeof ret === 'object' && ret !== null) {
            ret = await ret;
        }

        if (typeof ret !== 'undefined') {
            return ret;
        }

        return isLastIndex ? null : true;
    };
}

module.exports = inlineCode;
