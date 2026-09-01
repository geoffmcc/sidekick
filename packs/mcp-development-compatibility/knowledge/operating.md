# MCP Development and Compatibility

Compatibility work is static and contract-oriented. The pack uses semantic
repository indexing and the live governed catalog; it does not start servers,
open arbitrary stdio/TCP/HTTP transports, invoke source code, or treat a tool
description as proof of wire compatibility. Transport and authentication tests
belong in an explicitly authorized test environment with normal policy gates.
