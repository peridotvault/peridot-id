// Vercel serverless entry point. The compiled NestJS app is produced by
// `nest build` (see buildCommand in vercel.json) and re-exported here so
// Vercel treats this repo as a Node.js serverless function.
module.exports = require("../dist/serverless.js").default;
