Python OpenVINO memory diagnostic

Files:
- run-python-memory-diagnostic.py : parent harness; runs CPU and NPU children separately
- python-memory-child.py          : child inference/memory test

Requires:
- Python 3.12 virtual environment
- openvino==2026.2.1
- numpy
- psutil

The parent enforces a hard timeout and terminates the whole Windows child process tree.
