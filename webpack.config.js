const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: {
      popup:              './src/popup/index.tsx',
      options:            './src/options/index.tsx',
      background:         './src/background/index.ts',
      'content/gmail':    './src/content/gmail.ts',
      'content/linkedin': './src/content/linkedin.ts',
      'content/jobPage':  './src/content/jobPage.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: false,
    },
    devtool: isDev ? 'cheap-module-source-map' : false,
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: { transpileOnly: true },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'public/manifest.json',                                    to: 'manifest.json'       },
          { from: 'public/popup.html',                                       to: 'popup.html'          },
          { from: 'public/options.html',                                     to: 'options.html'        },
          { from: 'public/icons',                                            to: 'icons'               },
          // pdf.js worker — loaded by the options page for PDF text extraction
          { from: 'node_modules/pdfjs-dist/build/pdf.worker.min.js',        to: 'pdf.worker.min.js'   },
        ],
      }),
    ],
    // Keep each bundle fully self-contained — no shared chunks across MV3 contexts
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
    },
  };
};
