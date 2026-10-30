const path = require('node:path');

/** Transpile the shared core for webpack 4's JavaScript parser. */
function withExtensionLoaderWebpack4(config, {hostRoot}) {
    if (!path.isAbsolute(hostRoot || '')) throw new TypeError('An absolute hostRoot is required');
    if (Array.isArray(config)) return config.map(item => withExtensionLoaderWebpack4(item, {hostRoot}));
    const resolve = name => require.resolve(name, {paths: [hostRoot]});
    return {...config, module: {...config.module, rules: [...(config.module?.rules || []), {
        test: /\.js$/,
        include: [__dirname],
        loader: resolve('babel-loader'),
        options: {babelrc: false, configFile: false,
            presets: [[resolve('@babel/preset-env'), {targets: {ie: '11'}, modules: false}]]}
    }]}};
}

module.exports = {withExtensionLoaderWebpack4};
