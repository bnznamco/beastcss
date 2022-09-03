import Beastcss from 'beastcss';
import { validate } from 'schema-utils';
import schema from './schema.json';

const PLUGIN_NAME = 'beastcss-webpack-plugin';

const privateCompilation = new WeakMap();

const privateSources = new WeakMap();

export default class BeastcssWebpackPlugin extends Beastcss {
  constructor(options) {
    validate(schema, options, {
      name: PLUGIN_NAME,
      baseDataPath: 'options',
    });

    super(options);
  }

  /**
   * @private
   * @returns {import('webpack').Compilation} Webpack Compilation
   */
  get compilation() {
    if (privateCompilation.has(this)) {
      return privateCompilation.get(this);
    }

    throw new Error('compilation is undefined.');
  }

  set compilation(compilation) {
    privateCompilation.set(this, compilation);
  }

  /**
   * @private
   * @returns {import('webpack').sources} Webpack Sources
   */
  get sources() {
    if (privateSources.has(this)) {
      return privateSources.get(this);
    }

    throw new Error('sources is undefined.');
  }

  set sources(sources) {
    privateSources.set(this, sources);
  }

  /** @param {import("webpack").Compiler} compiler Webpack Compiler */
  apply(compiler) {
    this.sources = compiler.webpack.sources;

    this.options.path = compiler.options.output.path;
    this.options.publicPath = compiler.options.output.publicPath || '';

    this.run(compiler);
  }

  run(compiler) {
    const htmlWebpackPlugins = compiler.options.plugins.filter(
      ({ constructor }) => constructor.name === 'HtmlWebpackPlugin'
    );

    compiler.hooks.afterEmit.tap(PLUGIN_NAME, () => this.clear());

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      this.compilation = compilation;
      this.fs = compilation.outputFileSystem;
      this.logger = compilation.getLogger
        ? compilation.getLogger(PLUGIN_NAME)
        : this.logger;

      htmlWebpackPlugins.forEach((HtmlWebpackPlugin) => {
        HtmlWebpackPlugin.constructor
          .getHooks(compilation)
          .beforeEmit.tapPromise(PLUGIN_NAME, async (htmlPluginData) => {
            try {
              const html = await this.process(
                htmlPluginData.html,
                htmlPluginData.outputName
              );

              htmlPluginData.html = html;
            } catch (e) {
              compilation.errors.push(e);

              return htmlPluginData;
            }

            return htmlPluginData;
          });
      });

      compilation.hooks.processAssets.tapPromise(
        {
          name: PLUGIN_NAME,
          stage: compilation.constructor.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE,
        },
        async (assets) => {
          try {
            const htmlAssets = this.findHtmlAssets(assets);

            if (htmlAssets.length === 0 && htmlWebpackPlugins.length === 0) {
              this.opts.logger.warn('Could not find any HTML asset.');
            }

            await Promise.all(
              htmlAssets.map(async (htmlAsset) => {
                const html = await this.process(
                  htmlAsset.html.toString(),
                  htmlAsset.name
                );

                this.compilation.updateAsset(
                  htmlAsset.name,
                  new this.sources.RawSource(html)
                );
              })
            );

            if (this.options.pruneSource) {
              await this.pruneSources();
            }
          } catch (e) {
            this.compilation.errors.push(e);
          }
        }
      );

      if (this.options.pruneSource) {
        compilation.hooks.processAssets.tapPromise(
          {
            name: PLUGIN_NAME,
            // html-webpack-plugin uses PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE
            stage:
              compilation.constructor.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE +
              100,
          },
          async () => this.pruneSources()
        );
      }
    });
  }

  findHtmlAssets(assets) {
    const htmlAssets = [];

    Object.keys(assets).forEach((asset) => {
      if (asset.match(/\.html$/)) {
        const html = this.compilation.getAsset(asset).source.source();

        if (!html) {
          this.opts.logger.warn(`Empty HTML asset "${asset}".`);

          return;
        }

        htmlAssets.push({
          name: asset,
          html,
        });
      }
    });

    return htmlAssets;
  }

  async getStylesheetSource(stylesheet, processId) {
    if (this.cachedStylesheetsSource.has(stylesheet.name)) {
      return this.cachedStylesheetsSource.get(stylesheet.name);
    }

    const asset = this.compilation.getAsset(stylesheet.name);

    if (asset && asset.source) {
      this.cachedStylesheetsSource.set(stylesheet.name, {
        content: asset.source.source().toString(),
        size: asset.source.size(),
      });

      return this.cachedStylesheetsSource.get(stylesheet.name);
    }

    const promise = (async () => {
      try {
        const content = await this.fs.readFile(stylesheet.path);

        return {
          content,
          size: Buffer.byteLength(content),
        };
      } catch (e) {
        this.logger.warn(
          `Unable to locate stylesheet: ${stylesheet.path}`,
          processId
        );

        return undefined;
      }
    })();

    this.cachedStylesheetsSource.set(stylesheet.name, promise);

    return promise;
  }

  async getAdditionalStylesheets() {
    // eslint-disable-next-line global-require
    const micromatch = require('micromatch');

    const additionalStylesheets = [];

    if (this.options.additionalStylesheets.length > 0) {
      await Promise.all(
        micromatch(
          Object.keys(this.compilation.assets),
          this.options.additionalStylesheets,
          {
            basename: true,
            posixSlashes: true,
          }
        ).map(async (name) => {
          const stylesheet = {
            path: this.getStylesheetPath(name),
            name,
          };

          additionalStylesheets.push(stylesheet);
        })
      );
    }

    return additionalStylesheets;
  }

  async updateStylesheet(stylesheet, css) {
    if (this.compilation.assets[stylesheet.name]) {
      this.compilation.updateAsset(
        stylesheet.name,
        new this.sources.RawSource(css) // TODO: add sourceMap
      );
    } else {
      await this.fs.writeFile(stylesheet.path, css);
    }
  }

  async removeStylesheet(stylesheet) {
    if (stylesheet.link) {
      stylesheet.link.remove();

      if (this.compilation.assets[stylesheet.name]) {
        delete this.compilation.assets[stylesheet.name];
      } else {
        await this.fs.removeFile(stylesheet.path);
      }
    }
  }
}
