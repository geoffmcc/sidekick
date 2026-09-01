# Software Supply Chain

Supply-chain results are reproducible observations: the exact parsed manifest,
lockfile digest, Git state, and bounded semantic projection are retained in the
tool result. The pack does not install dependencies, contact registries, run
package scripts, or infer trust from a package name. A digest proves bytes, not
provenance or safety; review signatures, policy and dependency intent separately.
