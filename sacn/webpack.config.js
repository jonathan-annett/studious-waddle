// webpack.config.js
import path from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    mode: 'production',
    // Bundle both JS files into a single payload
    entry: ['./public/dmx-console.js', './public/app.js'],
    output: {
        filename: 'js/bundle.[contenthash].min.js',
        path: path.resolve(__dirname, 'dist'),
        clean: true, // Empties the dist folder before every build
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                extractComments: false,
                terserOptions: {
                    format: {
                        comments: false, // Strip all comments
                    },
                    compress: {
                        drop_console: false, // Keep console.logs for network debugging
                    }
                },
            }),
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './public/index.html',
            inject: 'body', // Injects the new bundle at the bottom of the body
            minify: {
                collapseWhitespace: true,
                removeComments: true,
                removeRedundantAttributes: true,
                useShortDoctype: true,
                minifyCSS: true, // Minifies any inline <style> blocks
                minifyJS: true   // Minifies any inline <script> blocks
            }
        }),
        
        // Custom Hook: Silently remove dev script tags from the production HTML
        {
            apply(compiler) {
                compiler.hooks.compilation.tap('RemoveDevScriptsPlugin', (compilation) => {
                    HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tapAsync(
                        'RemoveDevScriptsPlugin',
                        (data, cb) => {
                            data.html = data.html.replace(/<script.*src=["']app\.js["'].*><\/script>/gi, '');
                            data.html = data.html.replace(/<script.*src=["']dmx-console\.js["'].*><\/script>/gi, '');
                            cb(null, data);
                        }
                    );
                });
            }
        },

        // Copy static vendor assets directly to dist
        new CopyWebpackPlugin({
            patterns: [
                { from: 'public/qrcode.min.js', to: 'qrcode.min.js' }
            ],
        }),
    ],
};