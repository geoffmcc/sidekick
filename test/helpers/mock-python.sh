#!/bin/bash
# Mock python executable for testing OpenVINO helper
# Usage: ./mock-python.sh -u path/to/script.js

# Ignore the -u flag and execute node on the script path
if [ "$1" == "-u" ]; then
  exec node "$2"
else
  exec node "$1"
fi
