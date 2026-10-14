import { describe, expect, it } from "vitest";
import {
  PlayPromotionSchema,
  SkillVersionSchema,
  sha256,
  type PlayPromotion,
  type SkillEvidenceState,
  type SkillVersion
} from "@amped-studio-os/contracts";
import { EngineStorage, StorageCursorError } from "@amped-studio-os/storage";

const EXAMPLE_A = "venture_example_a";
const EXAMPLE_C = "venture_example_c";
const PRIMARY_SKILL = "skill_cursor_primary";
const PRIMARY_PLAY = "play_cursor_primary";

function storageFixture(): EngineStorage {
  const storage = new EngineStorage(":memory:");
  const insert = storage.db.prepare(
    `INSERT INTO ventures(id,slug,company_slug,name,owner,owning_repo,lifecycle_state,created_at,updated_at)
     VALUES(?,?,?,?,?,?, 'candidate', ?, ?)`
  );
  for (const [ventureId, slug] of [
    [EXAMPLE_A, "example-a"],
    [EXAMPLE_C, "example-c"]
  ] as const) {
    insert.run(ventureId, slug, slug, slug.toUpperCase(), "founder", `/tmp/${slug}`, "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
  }
  return storage;
}

function skillVersion(input: {
  id: string;
  revision: number;
  createdAt: string;
  ventureId?: string;
  skillId?: string;
  state?: SkillEvidenceState;
  supersedesSkillVersionId?: string;
}): SkillVersion {
  const ventureId = input.ventureId ?? EXAMPLE_A;
  const skillId = input.skillId ?? PRIMARY_SKILL;
  return SkillVersionSchema.parse({
    id: input.id,
    revision: input.revision,
    ventureId,
    skillId,
    version: `0.0.${input.revision}`,
    name: `Cursor test ${skillId}`,
    state: input.state ?? "candidate",
    artifactPath: `skills/${skillId}/SKILL.md`,
    artifactHash: sha256({ artifact: input.id }),
    applicability: ["Stable storage cursor pagination"],
    exclusions: [],
    assumptions: [],
    mutableSurface: ["packages/storage/src/index.ts"],
    evidenceIds: [],
    evaluationContractIds: [],
    experimentRecordIds: [],
    evaluatedVentureIds: [],
    ...(input.supersedesSkillVersionId ? { supersedesSkillVersionId: input.supersedesSkillVersionId } : {}),
    producerId: "storage-pagination-test",
    recordedBy: "storage-pagination-test",
    reason: "Exercise immutable cursor ordering and scope",
    recordedAt: input.createdAt,
    idempotencyKey: `skill-cursor-${ventureId}-${input.id}`,
    createdAt: input.createdAt,
    canonicalHash: sha256({ kind: "skill-version", ventureId, id: input.id })
  });
}

function insertSkillChain(
  storage: EngineStorage,
  rows: ReadonlyArray<{ id: string; createdAt: string }>,
  options: { ventureId?: string; skillId?: string; state?: SkillEvidenceState } = {}
): SkillVersion[] {
  let supersedesSkillVersionId: string | undefined;
  return rows.map((row, index) => {
    const record = skillVersion({
      ...row,
      revision: index + 1,
      ...options,
      ...(supersedesSkillVersionId ? { supersedesSkillVersionId } : {})
    });
    expect(storage.createSkillVersion(record)).toMatchObject({ created: true });
    supersedesSkillVersionId = record.id;
    return record;
  });
}

function promotion(input: {
  id: string;
  revision: number;
  createdAt: string;
  skillVersionId: string;
  ventureId?: string;
  playId?: string;
  toState?: SkillEvidenceState;
  supersedesPlayPromotionId?: string;
}): PlayPromotion {
  const ventureId = input.ventureId ?? EXAMPLE_A;
  const playId = input.playId ?? PRIMARY_PLAY;
  const toState = input.toState ?? "candidate";
  return PlayPromotionSchema.parse({
    id: input.id,
    revision: input.revision,
    ventureId,
    playId,
    skillVersionId: input.skillVersionId,
    fromState: "candidate",
    toState,
    decision: toState === "deprecated" ? "deprecate" : "refuse",
    evaluationContractIds: ["evaluation_cursor_fixture"],
    experimentRecordIds: ["experiment_cursor_fixture"],
    evidenceIds: ["evidence_cursor_fixture"],
    transferVentureIds: [],
    outcomeDefinitionHash: sha256({ outcome: input.id }),
    supportedArchetypes: ["storage test"],
    unsupportedArchetypes: [],
    noHistoryBaselineReceiptIds: [],
    plainAgentBaselineReceiptIds: [],
    hardGatesPassed: true,
    leakageDetected: false,
    costWithinTolerance: true,
    founderTimeWithinTolerance: true,
    complexityWithinTolerance: true,
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promotion-authority",
    reason: "Exercise immutable promotion pagination",
    nextBoundedTest: "Continue only from a scope-valid cursor",
    requestedAt: input.createdAt,
    idempotencyKey: `promotion-cursor-${ventureId}-${input.id}`,
    ...(input.supersedesPlayPromotionId ? { supersedesPlayPromotionId: input.supersedesPlayPromotionId } : {}),
    createdAt: input.createdAt,
    canonicalHash: sha256({ kind: "play-promotion", ventureId, id: input.id })
  });
}

function insertPromotion(storage: EngineStorage, record: PlayPromotion): void {
  storage.db
    .prepare(
      `INSERT INTO play_promotions(venture_id,id,play_id,skill_version_id,revision,decision,target_state,canonical_hash,record_json,
         supersedes_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      record.ventureId,
      record.id,
      record.playId,
      record.skillVersionId,
      record.revision,
      record.decision,
      record.toState,
      record.canonicalHash,
      JSON.stringify(record),
      record.supersedesPlayPromotionId ?? null,
      record.idempotencyKey,
      record.createdAt
    );
}

describe("immutable storage cursor pagination", () => {
  it("pages skill versions by created time and ID without drift from newer inserts", () => {
    const storage = storageFixture();
    try {
      const initial = insertSkillChain(storage, [
        { id: "skillver_cursor_a", createdAt: "2026-07-20T00:00:01.000Z" },
        { id: "skillver_cursor_b", createdAt: "2026-07-20T00:00:03.000Z" },
        { id: "skillver_cursor_c", createdAt: "2026-07-20T00:00:03.000Z" },
        { id: "skillver_cursor_d", createdAt: "2026-07-20T00:00:02.000Z" },
        { id: "skillver_cursor_e", createdAt: "2026-07-20T00:00:00.000Z" }
      ]);

      const first = storage.listSkillVersions(EXAMPLE_A, { skillId: PRIMARY_SKILL, limit: 2, includePageInfo: true });
      expect(first.records.map((record) => record.id)).toEqual(["skillver_cursor_c", "skillver_cursor_b"]);
      expect(first.nextCursor).toBe("skillver_cursor_b");

      storage.createSkillVersion(
        skillVersion({
          id: "skillver_cursor_newer",
          revision: 6,
          createdAt: "2026-07-20T00:00:04.000Z",
          supersedesSkillVersionId: initial.at(-1)!.id
        })
      );

      const second = storage.listSkillVersions(EXAMPLE_A, {
        skillId: PRIMARY_SKILL,
        limit: 2,
        cursor: first.nextCursor!,
        includePageInfo: true
      });
      expect(second.records.map((record) => record.id)).toEqual(["skillver_cursor_d", "skillver_cursor_a"]);
      expect(second.nextCursor).toBe("skillver_cursor_a");

      const third = storage.listSkillVersions(EXAMPLE_A, {
        skillId: PRIMARY_SKILL,
        limit: 2,
        cursor: second.nextCursor!,
        includePageInfo: true
      });
      expect(third.records.map((record) => record.id)).toEqual(["skillver_cursor_e"]);
      expect(third).not.toHaveProperty("nextCursor");

      const legacy = storage.listSkillVersions(EXAMPLE_A, { skillId: PRIMARY_SKILL, limit: 2 });
      expect(Array.isArray(legacy)).toBe(true);
      expect(legacy.map((record) => record.id)).toEqual(["skillver_cursor_newer", "skillver_cursor_c"]);
    } finally {
      storage.close();
    }
  });

  it("rejects skill cursors outside the requested venture or filter scope", () => {
    const storage = storageFixture();
    try {
      insertSkillChain(storage, [{ id: "skillver_primary", createdAt: "2026-07-20T01:00:00.000Z" }]);
      const otherSkill = insertSkillChain(
        storage,
        [{ id: "skillver_other", createdAt: "2026-07-20T01:01:00.000Z" }],
        { skillId: "skill_cursor_other", state: "draft" }
      )[0]!;
      const foreign = insertSkillChain(
        storage,
        [{ id: "skillver_foreign", createdAt: "2026-07-20T01:02:00.000Z" }],
        { ventureId: EXAMPLE_C }
      )[0]!;

      expect(() =>
        storage.listSkillVersions(EXAMPLE_A, { skillId: PRIMARY_SKILL, cursor: otherSkill.id, includePageInfo: true })
      ).toThrowError(StorageCursorError);
      expect(() =>
        storage.listSkillVersions(EXAMPLE_A, { cursor: foreign.id, includePageInfo: true })
      ).toThrowError(StorageCursorError);
      expect(() =>
        storage.listSkillVersions(EXAMPLE_A, { state: "candidate", cursor: otherSkill.id, includePageInfo: true })
      ).toThrowError(StorageCursorError);
      expect(() => storage.listSkillVersions(EXAMPLE_A, { limit: 0, includePageInfo: true })).toThrowError(RangeError);
    } finally {
      storage.close();
    }
  });

  it("pages play promotions stably and binds cursors to every active filter", () => {
    const storage = storageFixture();
    try {
      const primarySkill = insertSkillChain(
        storage,
        [{ id: "skillver_promotion_primary", createdAt: "2026-07-20T02:00:00.000Z" }]
      )[0]!;
      const otherSkill = insertSkillChain(
        storage,
        [{ id: "skillver_promotion_other", createdAt: "2026-07-20T02:00:01.000Z" }],
        { skillId: "skill_cursor_promotion_other" }
      )[0]!;
      let supersedesPlayPromotionId: string | undefined;
      const rows = [
        ["promotion_cursor_a", "2026-07-20T03:00:01.000Z"],
        ["promotion_cursor_b", "2026-07-20T03:00:03.000Z"],
        ["promotion_cursor_c", "2026-07-20T03:00:03.000Z"],
        ["promotion_cursor_d", "2026-07-20T03:00:02.000Z"],
        ["promotion_cursor_e", "2026-07-20T03:00:00.000Z"]
      ] as const;
      for (const [index, [id, createdAt]] of rows.entries()) {
        const record = promotion({
          id,
          revision: index + 1,
          createdAt,
          skillVersionId: primarySkill.id,
          ...(supersedesPlayPromotionId ? { supersedesPlayPromotionId } : {})
        });
        insertPromotion(storage, record);
        supersedesPlayPromotionId = record.id;
      }

      const first = storage.listPlayPromotions(EXAMPLE_A, {
        playId: PRIMARY_PLAY,
        skillVersionId: primarySkill.id,
        state: "candidate",
        limit: 2,
        includePageInfo: true
      });
      expect(first.records.map((record) => record.id)).toEqual(["promotion_cursor_c", "promotion_cursor_b"]);
      expect(first.nextCursor).toBe("promotion_cursor_b");

      const newer = promotion({
        id: "promotion_cursor_newer",
        revision: 6,
        createdAt: "2026-07-20T03:00:04.000Z",
        skillVersionId: primarySkill.id,
        supersedesPlayPromotionId: supersedesPlayPromotionId!
      });
      insertPromotion(storage, newer);
      supersedesPlayPromotionId = newer.id;

      const second = storage.listPlayPromotions(EXAMPLE_A, {
        playId: PRIMARY_PLAY,
        skillVersionId: primarySkill.id,
        state: "candidate",
        limit: 2,
        cursor: first.nextCursor!,
        includePageInfo: true
      });
      expect(second.records.map((record) => record.id)).toEqual(["promotion_cursor_d", "promotion_cursor_a"]);
      expect(second.nextCursor).toBe("promotion_cursor_a");

      const third = storage.listPlayPromotions(EXAMPLE_A, {
        playId: PRIMARY_PLAY,
        skillVersionId: primarySkill.id,
        state: "candidate",
        limit: 2,
        cursor: second.nextCursor!,
        includePageInfo: true
      });
      expect(third.records.map((record) => record.id)).toEqual(["promotion_cursor_e"]);
      expect(third).not.toHaveProperty("nextCursor");

      const wrongSkill = promotion({
        id: "promotion_cursor_wrong_skill",
        revision: 7,
        createdAt: "2026-07-20T03:00:05.000Z",
        skillVersionId: otherSkill.id,
        supersedesPlayPromotionId
      });
      insertPromotion(storage, wrongSkill);
      supersedesPlayPromotionId = wrongSkill.id;
      const wrongState = promotion({
        id: "promotion_cursor_wrong_state",
        revision: 8,
        createdAt: "2026-07-20T03:00:06.000Z",
        skillVersionId: primarySkill.id,
        toState: "deprecated",
        supersedesPlayPromotionId
      });
      insertPromotion(storage, wrongState);

      const foreignSkill = insertSkillChain(
        storage,
        [{ id: "skillver_promotion_foreign", createdAt: "2026-07-20T02:00:00.000Z" }],
        { ventureId: EXAMPLE_C }
      )[0]!;
      const foreign = promotion({
        id: "promotion_cursor_foreign",
        revision: 1,
        createdAt: "2026-07-20T03:00:00.000Z",
        skillVersionId: foreignSkill.id,
        ventureId: EXAMPLE_C
      });
      insertPromotion(storage, foreign);

      expect(() =>
        storage.listPlayPromotions(EXAMPLE_A, {
          playId: PRIMARY_PLAY,
          skillVersionId: primarySkill.id,
          cursor: wrongSkill.id,
          includePageInfo: true
        })
      ).toThrowError(StorageCursorError);
      expect(() =>
        storage.listPlayPromotions(EXAMPLE_A, { state: "candidate", cursor: wrongState.id, includePageInfo: true })
      ).toThrowError(StorageCursorError);
      expect(() =>
        storage.listPlayPromotions(EXAMPLE_A, { cursor: foreign.id, includePageInfo: true })
      ).toThrowError(StorageCursorError);

      const legacy = storage.listPlayPromotions(EXAMPLE_A, { playId: PRIMARY_PLAY, limit: 1 });
      expect(Array.isArray(legacy)).toBe(true);
    } finally {
      storage.close();
    }
  });
});
