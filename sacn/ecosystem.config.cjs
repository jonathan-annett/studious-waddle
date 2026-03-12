module.exports = {
    apps: [
        {
            name: "sacn-hub",
            script: "./server.js",
            watch: false,
            // By default, PM2 runs this in Dev mode (serving /public)
            env: {
                NODE_ENV: "development",
            },
            // When we pass --env production, PM2 switches to serving /dist
            env_production: {
                NODE_ENV: "production",
            }
        },
        {
            name: "test-1",
            script: "./test-sacn.js",
            args: "--universe 1 --name test-1 --relay 2",
            watch: false
        },
        {
            name: "test-2",
            script: "./test-sacn.js",
            args: "--universe 2 --name test-2",
            watch: false
        }
    ]
};