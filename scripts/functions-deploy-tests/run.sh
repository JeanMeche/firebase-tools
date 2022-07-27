#!/bin/bash
set -e # Immediately exit on failure

# Globally link the CLI for the testing framework
./scripts/npm-link.sh

mocha scripts/functions-deploy-tests/tests.ts