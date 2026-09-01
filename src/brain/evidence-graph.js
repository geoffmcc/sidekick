"use strict";

const LIMITS = Object.freeze({ MAX_NODES: 256, MAX_EDGES: 512, MAX_TEXT: 1200, MAX_REF: 180 });
const NODE_TYPES = new Set(["objective", "deliverable", "requirement", "claim", "evidence", "verification", "artifact", "receipt", "memory"]);
const RELATIONS = new Set(["supports", "contradicts", "satisfies", "verifies", "produces", "references", "derived_from"]);

function clean(value, max = LIMITS.MAX_TEXT) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function ref(value) {
  const result = clean(value, LIMITS.MAX_REF);
  if (!/^(?:task|requirement|claim|evidence|receipt|recipe|artifact|memory|deliverable|objective):[A-Za-z0-9_.:-]{1,160}$/.test(result)) throw new Error("graph references must be governed references");
  return result;
}
function createGraph(taskId) { return { version: 3, task_id: clean(taskId, 80), nodes: [], edges: [] }; }
function addNode(graph, node) {
  if (!graph || !NODE_TYPES.has(node?.type)) throw new Error("unsupported graph node type");
  const id = ref(node.id);
  if (graph.nodes.length >= LIMITS.MAX_NODES && !graph.nodes.some(item => item.id === id)) throw new Error("evidence graph node bound exceeded");
  if (graph.nodes.some(item => item.id === id)) return graph;
  const next = { id, type: node.type, summary: clean(node.summary), freshness: clean(node.freshness, 32) || "unknown", completeness: clean(node.completeness, 32) || "unknown", provenance: clean(node.provenance, 240) || "server-recorded" };
  return { ...graph, nodes: [...graph.nodes, next] };
}
function addEdge(graph, edge) {
  if (!graph || !RELATIONS.has(edge?.relation)) throw new Error("unsupported graph relation");
  const from = ref(edge.from); const to = ref(edge.to);
  if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to)) throw new Error("graph edge references an unknown node");
  if (graph.edges.length >= LIMITS.MAX_EDGES && !graph.edges.some(item => item.from === from && item.to === to && item.relation === edge.relation)) throw new Error("evidence graph edge bound exceeded");
  if (graph.edges.some(item => item.from === from && item.to === to && item.relation === edge.relation)) return graph;
  return { ...graph, edges: [...graph.edges, { from, to, relation: edge.relation }] };
}
function coverage(graph, requirements = []) {
  return requirements.slice(0, 64).map(requirement => {
    const id = ref(requirement.id || requirement);
    const edges = graph.edges.filter(edge => edge.to === id && ["satisfies", "verifies", "supports"].includes(edge.relation));
    const contradictions = graph.edges.filter(edge => edge.to === id && edge.relation === "contradicts");
    return { id, state: contradictions.length ? "contradicted" : edges.length ? "supported" : "unverified", evidence_refs: edges.map(edge => edge.from).slice(0, 16), contradictions: contradictions.map(edge => edge.from).slice(0, 16) };
  });
}
module.exports = { LIMITS, NODE_TYPES, RELATIONS, createGraph, addNode, addEdge, coverage, ref };
