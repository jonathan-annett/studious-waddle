const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
    // We only need production mode for a vendor bundle
    mode: 'production', 
    
    // The tiny file we created above
    entry: './src/vendor.js', 

    output: {
        // The name of the file it will spit out
        filename: 'streamdeck-vendor.js', 
        path: path.resolve(__dirname, 'dist'),
        
        // This is the magic part: it takes the exports from vendor.js
        // and attaches them to window.StreamDeck
        library: {
            name: 'StreamDeck',
            type: 'window',
            export: 'default' // We only want the default export attached
        },
        clean: true,
        
    },

    plugins: [
        // Automatically copies everything from your public/ folder (like index.html) to dist/
        new CopyWebpackPlugin({
            patterns: [
                { 
                    from: path.join(__dirname, '/public'), 
                    to: path.join(__dirname, '/dist'),
                    noErrorOnMissing: true ,
                    // This tells Webpack's Terser plugin to leave these files completely alone
                    info: { minimized: true }
                }
            ],
        })
    ],
};