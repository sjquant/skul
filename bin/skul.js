#!/usr/bin/env node

const { run } = require("../dist/index.js");

void run(process.argv.slice(2))
  .then((output) => {
    console.log(output);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
