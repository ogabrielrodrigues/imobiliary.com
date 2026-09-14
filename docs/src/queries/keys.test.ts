import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queryKeys, staleAfter } from "./keys.ts";

/** True when `prefix` matches the start of `key`, as an invalidation does. */
function covers(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  return prefix.every((part, index) => Object.is(part, key[index]));
}

function coveredBy(change: keyof typeof staleAfter, key: readonly unknown[]): boolean {
  return staleAfter[change].some((prefix) => covers(prefix, key));
}

describe("query keys", () => {
  it("start with their resource, so one prefix invalidates it all", () => {
    assert.ok(covers(queryKeys.templates, queryKeys.templateList()));
    assert.ok(covers(queryKeys.templates, queryKeys.templateContent("t1", 2)));
    assert.ok(covers(queryKeys.documents, queryKeys.batchDocuments("b1")));
    assert.ok(covers(queryKeys.history, queryKeys.historyPage(3, "t1")));
    assert.ok(covers(queryKeys.dashboard, queryKeys.dashboardView(30, "UTC")));
  });

  it("tell versions, pages, filters and batches apart", () => {
    assert.notDeepEqual(queryKeys.templateContent("t1", 1), queryKeys.templateContent("t1", 2));
    assert.notDeepEqual(
      queryKeys.templateContent("t1", undefined),
      queryKeys.templateContent("t1", 1),
    );
    assert.notDeepEqual(queryKeys.historyPage(0, undefined), queryKeys.historyPage(1, undefined));
    assert.notDeepEqual(queryKeys.historyPage(0, undefined), queryKeys.historyPage(0, "t1"));
    assert.notDeepEqual(queryKeys.batchDocuments("b1"), queryKeys.batchDocuments("b2"));
    assert.notDeepEqual(
      queryKeys.dashboardView(30, "America/Sao_Paulo"),
      queryKeys.dashboardView(30, "UTC"),
    );
  });
});

describe("what each change makes stale", () => {
  it("generating a document refreshes the history, documents and the dashboard, not templates", () => {
    assert.ok(coveredBy("documentGenerated", queryKeys.historyPage(0, undefined)));
    assert.ok(coveredBy("documentGenerated", queryKeys.batchDocuments("b1")));
    assert.ok(coveredBy("documentGenerated", queryKeys.dashboardView(7, "UTC")));
    assert.ok(!coveredBy("documentGenerated", queryKeys.templateList()));
  });

  it("creating a template refreshes the list, the history's filter and the dashboard", () => {
    assert.ok(coveredBy("templateCreated", queryKeys.templateList()));
    assert.ok(coveredBy("templateCreated", queryKeys.historyPage(0, undefined)));
    assert.ok(coveredBy("templateCreated", queryKeys.dashboardView(30, "UTC")));
  });

  it("publishing a version refreshes that template's content", () => {
    assert.ok(coveredBy("versionPublished", queryKeys.templateContent("t1", undefined)));
  });

  it("deleting a template refreshes the history too, whose rows name it", () => {
    assert.ok(coveredBy("templateDeleted", queryKeys.templateList()));
    assert.ok(coveredBy("templateDeleted", queryKeys.historyPage(2, "t1")));
    assert.ok(coveredBy("templateDeleted", queryKeys.dashboardView(90, "UTC")));
  });

  it("changing a batch refreshes the history, its documents and the dashboard", () => {
    assert.ok(coveredBy("batchChanged", queryKeys.historyPage(0, undefined)));
    assert.ok(coveredBy("batchChanged", queryKeys.batchDocuments("b1")));
    assert.ok(coveredBy("batchChanged", queryKeys.dashboardView(30, "UTC")));
    assert.ok(!coveredBy("batchChanged", queryKeys.templateList()));
  });
});
