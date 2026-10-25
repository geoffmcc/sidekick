"use strict";

/**
 * Release-committed package hashes for bundled first-party capability packs.
 *
 * Provenance is an execution trust grant, so a directory's location under
 * `packs/` is not sufficient evidence by itself. These hashes are maintained
 * separately from the pack contents and must be updated in a reviewed,
 * signed change whenever a bundled package changes.
 */
const EXPECTED_PACKAGE_HASHES = Object.freeze({
  "api-engineering": "38002555e635503ea6e4a8aea91ba3220edecf8dc4e0ab65a350792c48e64122",
  "assumptions-unknowns": "3fe939bd1fa4df4d628caf17a2f337d76a4d8b15d2c9d6a9ba6170452af19a09",
  "backup-restore-dr": "f50e8513172c353f669c00ee669903961649a8c4258a3aa3b920483ad86d2e29",
  "browser-automation": "066a178a7741be43094e78df724e864feb47347fbbfc2f87b428ab6622f68313",
  "change-impact": "d38867ab1927f101b60ffc40238d251faeed3e2033d4e320b4b31351153bd50c",
  "ci-cd-release-engineering": "d7fd399df7e8fec36a2e5ba5b0b90fdd10b859dcbaa9356f9fbaef4c9fe2fe94",
  "container-operations": "4b87c8c16be03f6b347ba673bbf6823585692e9f472b8e8e77ad9c5f75c2db6d",
  "database-administration": "020337c83e60e94bb6bedb1e62d52f2ab5c6c128dc84f1e96d8abb72bd7099cb",
  developer: "f3311c07bb0acd0eab53921f972ea7ce40f38755113601c8bdb018bcd69cd6f7",
  "documentation-knowledge": "9a0734e4fd0acdac1e39b25e69504947d162d73f6e88230e7877dbf576802409",
  "infrastructure-as-code": "5240bf35e5709a3f08a1ac404d3d5d566393043e023b422a0e8de659e2429beb",
  jellyfin: "956167101ceb5224a62f2451c28bced478f31f6a287e0765d30dd1b38d95ca13",
  "linux-systems-administration": "ca1f8fdf5168895a4537bbc6e0cbfdca1721a910d0453f0d1ecd37fdd522a8fd",
  "local-ai-model-operations": "8d0266031ac7e9ee6b6a06f56e018bfbcc16ef22f98dff011304034ca02b3192",
  "mcp-development-compatibility": "d23f721e4b80b17e0f86c345b2ff39bf636d39f5cc2d2f393550e4655df83d84",
  "network-firewall": "c4bccfe5f3aa62d260675232172772cc1ef933e00e87712b3b1dd2845393448f",
  "network-services": "5891b46fb2cdb62be18b78d4b421126d94ae36abe7a852179b1e3e3c849cd68d",
  "observability-incident-response": "99baceaca9b4b0b2ea0cf68046c41b1c0d228dbe35084a729810b5daed988f68",
  "operational-readiness": "5338abe55a97ad2bd79ef16ba0f8e163fa8fb81c4ca637ef675011d15a35cb7c",
  proxmox: "2c70c5df293cbb4ad33d504281be90c79940cb2f3aa97dfb9d752807898e04ca",
  reproducibility: "7f3cf80331ff8e320ffc23ee0576f2a17621152241d07a8ab0310ddbffbda4df",
  "security-lab-reproduction": "817cb35729438f4c1d52b65439f2d505ea3708ace380fad81ab41130c7ab6e3a",
  "security-research": "29488110a28b17a992d220bf75cc8a81e6ec2940389c6c967cc2da69b4fffa2c",
  "skeptical-verifier": "02437b505a602c26f40b1b3fd8e359924f383b031d80065f635929745fcf442d",
  "software-supply-chain": "9d2d13ca71f0ecb9d70862696ecb23064851bb1d11b98770661a39963426a7bf",
  "storage-filesystems": "fdd519d27f47985e543a39ac5f199bb0d7f1d764303e02a801462c9f2ed89a6e",
  "testing-quality-engineering": "3b9376e7202b31ca454d81e88345aa46097321776cf38307d175a3a570a05180",
});

function verifyBundledPackageHash(name, packageHash) {
  const expected = EXPECTED_PACKAGE_HASHES[String(name || "")];
  return Boolean(expected && typeof packageHash === "string" && packageHash === expected);
}

module.exports = { EXPECTED_PACKAGE_HASHES, verifyBundledPackageHash };
