import openBrowser from 'react-dev-utils/openBrowser';
import getWebpackCommonConfig from './config/getWebpackCommonConfig';
import updateWebpackConfig from './config/updateWebpackConfig';
import UglifyJsPlugin from 'uglifyjs-webpack-plugin';

const fs = require('fs');
const path = require('path');
const { escapeWinPath } = require('./utils/escape-win-path');
const mkdirp = require('mkdirp');
const nunjucks = require('nunjucks');
const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const R = require('ramda');
const ghPages = require('gh-pages');
const getBishengConfig = require('./utils/get-bisheng-config');
const sourceData = require('./utils/source-data');
const generateFilesPath = require('./utils/generate-files-path');
const context = require('./context');

const entryTemplate = fs.readFileSync(path.join(__dirname, 'entry.nunjucks.js')).toString();
const routesTemplate = fs.readFileSync(path.join(__dirname, 'routes.nunjucks.js')).toString();
const tmpDirPath = path.join(__dirname, '..', 'tmp');
mkdirp.sync(tmpDirPath);

function getRoutesPath(configPath, themePath, configEntryName) {
  const routesPath = path.join(tmpDirPath, `routes.${configEntryName}.js`);
  const themeConfig = require(escapeWinPath(configPath)).themeConfig || {};
  fs.writeFileSync(
    routesPath,
    nunjucks.renderString(routesTemplate, {
      themeConfig: JSON.stringify(themeConfig),
      themePathRoute: escapeWinPath(path.join(themePath, require(escapeWinPath(themePath)).routes)),
      themePathConfig: escapeWinPath(themePath),
    }),
  );
  return routesPath;
}

function generateEntryFile(configPath, configTheme, configEntryName, root) {
  const entryPath = path.join(tmpDirPath, `entry.${configEntryName}.js`);
  const routesPath = getRoutesPath(
    configPath,
    path.dirname(configTheme),
    configEntryName,
  );
  fs.writeFileSync(
    entryPath,
    nunjucks.renderString(entryTemplate, {
      routesPath: escapeWinPath(routesPath),
      root: escapeWinPath(root),
    }),
  );
}

exports.start = function start(program) {
  const configFile = path.join(process.cwd(), program.config || 'eocky.config.js');
  const bishengConfig = getBishengConfig(configFile);
  context.initialize({ bishengConfig });
  mkdirp.sync(bishengConfig.output);

  const template = fs.readFileSync(bishengConfig.htmlTemplate).toString();
  const templateData = Object.assign({ root: '/' }, bishengConfig.htmlTemplateExtraData || {});
  const templatePath = path.join(process.cwd(), bishengConfig.output, 'index.html');
  fs.writeFileSync(templatePath, nunjucks.renderString(template, templateData));

  generateEntryFile(
    configFile,
    bishengConfig.theme,
    bishengConfig.entryName,
    '/',
  );

  const webpackConfig = updateWebpackConfig(getWebpackCommonConfig(), 'start');
  webpackConfig.plugins.push(new webpack.HotModuleReplacementPlugin());
  const serverOptions = {
    quiet: true,
    ...bishengConfig.devServerConfig,
    contentBase: path.join(process.cwd(), bishengConfig.output),
    historyApiFallback: true,
    hot: true,
    host: 'localhost',
  };
  WebpackDevServer.addDevServerEntrypoints(webpackConfig, serverOptions);
  const compiler = webpack(webpackConfig);

  // Ref: https://github.com/pigcan/blog/issues/6
  // Webpack startup recompilation fix. Remove when @sokra fixes the bug.
  // https://github.com/webpack/webpack/issues/2983
  // https://github.com/webpack/watchpack/issues/25
  const timefix = 11000;
  compiler.plugin('watch-run', (watching, callback) => {
    watching.startTime += timefix;
    callback()
  });
  compiler.plugin('done', (stats) => {
    stats.startTime -= timefix
  })

  const server = new WebpackDevServer(compiler, serverOptions);
  server.listen(
    bishengConfig.port, '0.0.0.0',
    () => openBrowser(`http://localhost:${bishengConfig.port}`)
  );
};

const ssrTemplate = fs.readFileSync(path.join(__dirname, 'ssr.nunjucks.js')).toString();

function filenameToUrl(filename) {
  if (filename.endsWith('index.html')) {
    return filename.replace(/index\.html$/, '');
  }
  return filename.replace(/\.html$/, '');
}
exports.build = function build(program, callback) {
  const configFile = path.join(process.cwd(), program.config || 'eocky.config.js');
  const bishengConfig = getBishengConfig(configFile);
  context.initialize({
    bishengConfig,
    isBuild: true,
  });
  mkdirp.sync(bishengConfig.output);

  const { entryName } = bishengConfig;
  generateEntryFile(
    configFile,
    bishengConfig.theme,
    entryName,
    bishengConfig.root,
  );
  const webpackConfig = updateWebpackConfig(getWebpackCommonConfig(), 'build');
  webpackConfig.plugins.push(new UglifyJsPlugin({
    uglifyOptions: {
      output: {
        ascii_only: true,
      },
    },
  }));
  webpackConfig.plugins.push(new webpack.DefinePlugin({
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  }));

  const ssrWebpackConfig = Object.assign({}, webpackConfig);
  const ssrPath = path.join(tmpDirPath, `ssr.${entryName}.js`);
  const routesPath = getRoutesPath(configFile, path.dirname(bishengConfig.theme), entryName);
  fs.writeFileSync(ssrPath, nunjucks.renderString(ssrTemplate, { routesPath: escapeWinPath(routesPath) }));

  ssrWebpackConfig.entry = {
    [`${entryName}-ssr`]: ssrPath,
  };
  ssrWebpackConfig.target = 'node';
  ssrWebpackConfig.output = Object.assign({}, ssrWebpackConfig.output, {
    path: tmpDirPath,
    library: 'ssr',
    libraryTarget: 'commonjs',
  });
  ssrWebpackConfig.plugins = ssrWebpackConfig.plugins
    .filter(plugin => !(plugin instanceof webpack.optimize.CommonsChunkPlugin));

  webpack(webpackConfig, (err, stats) => {
    if (err !== null) {
      return console.error(err);
    }

    if (stats.hasErrors()) {
      console.log(stats.toString('errors-only'));
      return;
    }

    // const markdown = sourceData.generate(bishengConfig.source, bishengConfig.transformers);
    // const themeConfig = require(bishengConfig.theme);
    // let filesNeedCreated = generateFilesPath(themeConfig.routes, markdown).map(bishengConfig.filePathMapper);
    let filesNeedCreated = [['index.html']];
    filesNeedCreated = R.unnest(filesNeedCreated);

    const template = fs.readFileSync(bishengConfig.htmlTemplate).toString();

    if (!program.ssr) {
      require('./loaders/common/boss').jobDone();
      const templateData = Object.assign({ root: bishengConfig.root }, bishengConfig.htmlTemplateExtraData || {});
      const fileContent = nunjucks.renderString(template, templateData);
      filesNeedCreated.forEach((file) => {
        const output = path.join(bishengConfig.output, file);
        mkdirp.sync(path.dirname(output));
        fs.writeFileSync(output, fileContent);
        console.log('Created: ', output);
      });

      if (callback) {
        callback();
      }
      return;
    }

    // context.turnOnSSRFlag();
    // // If we can build webpackConfig without errors, we can build ssrWebpackConfig without errors.
    // // Because ssrWebpackConfig are just part of webpackConfig.
    // webpack(ssrWebpackConfig, () => {
    //   require('./loaders/common/boss').jobDone();

    //   const { ssr } = require(path.join(tmpDirPath, `${entryName}-ssr`));
    //   const fileCreatedPromises = filesNeedCreated.map((file) => {
    //     const output = path.join(bishengConfig.output, file);
    //     mkdirp.sync(path.dirname(output));
    //     return new Promise((resolve) => {
    //       ssr(filenameToUrl(file), (error, content) => {
    //         if (error) {
    //           console.error(error);
    //           process.exit(1);
    //         }
    //         const templateData = Object.assign({ root: bishengConfig.root, content }, bishengConfig.htmlTemplateExtraData || {});
    //         const fileContent = nunjucks
    //                 .renderString(template, templateData);
    //         fs.writeFileSync(output, fileContent);
    //         console.log('Created: ', output);
    //         resolve();
    //       });
    //     });
    //   });
    //   Promise.all(fileCreatedPromises)
    //     .then(() => {
    //       if (callback) {
    //         callback();
    //       }
    //     });
    // });
  });
};

function pushToGhPages(basePath, config) {
  const options = {
    ...config,
    depth: 1,
    logger(message) {
      console.log(message);
    },
  };
  if (process.env.RUN_ENV_USER) {
    options.user = {
      name: process.env.RUN_ENV_USER,
      email: process.env.RUN_ENV_EMAIL,
    };
  }
  ghPages.publish(basePath, options, (err) => {
    if (err) {
      throw err;
    }
    console.log('Site has been published!');
  });
}
exports.deploy = function deploy(program) {
  const config = {
    remote: program.remote,
    branch: program.branch,
  };
  if (program.pushOnly) {
    const output = typeof program.pushOnly === 'string' ? program.pushOnly : './_site';
    const basePath = path.join(process.cwd(), output);
    pushToGhPages(basePath, config);
  } else {
    const configFile = path.join(process.cwd(), program.config || 'eocky.config.js');
    const bishengConfig = getBishengConfig(configFile);
    const basePath = path.join(process.cwd(), bishengConfig.output);
    exports.build(program, () => pushToGhPages(basePath, config));
  }
};
