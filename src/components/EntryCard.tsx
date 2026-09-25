import { useEffect, useState } from "react";
import { addFavorite, examples, removeFavorite } from "../api";
import type { Entry, Sentence } from "../types";
import { GENDER_LABELS, POS_LABELS, RULE_LABELS, TAG_LABELS } from "./labels";
import AiPanel from "./AiPanel";
import SpeakButton from "./SpeakButton";

function Ipa({ ipa }: { ipa: Entry["ipa"] }) {
  if (!ipa) return null;
  if (typeof ipa === "string") {
    return ipa ? <span className="text-emerald-700 dark:text-emerald-400">/{ipa}/</span> : null;
  }
  return (
    <>
      {ipa.uk && <span className="text-emerald-700 dark:text-emerald-400">英 /{ipa.uk}/</span>}
      {ipa.us && <span className="text-emerald-700 dark:text-emerald-400">美 /{ipa.us}/</span>}
    </>
  );
}

function Chips({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          title={`收录于「${TAG_LABELS[t] ?? t}」考试词表`}
          className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
        >
          {TAG_LABELS[t] ?? t}
        </span>
      ))}
    </div>
  );
}

function Senses({ entry }: { entry: Entry }) {
  const senses = entry.senses ?? [];
  if (senses.length === 0) return <p className="text-sm text-zinc-400">暂无释义</p>;
  return (
    <ol className="space-y-2">
      {senses.map((s, i) => (
        <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed">
          <span className="font-dict mt-0.5 min-w-5 text-right text-xs italic leading-6 text-emerald-600/80 dark:text-emerald-400/70">
            {i + 1}.
          </span>
          <div className="min-w-0">
            <span className="text-zinc-800 dark:text-zinc-200">{s.zh ?? s.fr ?? "—"}</span>
            {s.en && <span className="ml-2 text-sm text-zinc-400">{s.en}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Examples({ entry, auto }: { entry: Entry; auto: boolean }) {
  const [sentences, setSentences] = useState<Sentence[] | null>(null);
  const [expanded, setExpanded] = useState(auto);

  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    examples(entry.lang, entry.entry_id)
      .then((r) => alive && setSentences(r))
      .catch(() => alive && setSentences([]));
    return () => {
      alive = false;
    };
  }, [entry.lang, entry.entry_id, expanded]);

  // 未展开（前两条之外按需加载）且没有例句时整块不展示
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-4 text-xs text-zinc-400 transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
      >
        显示例句
      </button>
    );
  }
  if (sentences === null || sentences.length === 0) return null;
  return (
    <section className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <h3 className="eyebrow text-zinc-400">例句</h3>
      <ul className="mt-2.5 space-y-2.5 border-l border-emerald-200/70 pl-3.5 dark:border-emerald-800/60">
        {sentences.map((s) => (
          <li key={s.id}>
            <p className="font-dict text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-200">{s.text}</p>
            {s.translation?.[0] && <p className="mt-0.5 text-sm text-zinc-400">{s.translation[0]}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function EntryCard({ entry, autoExamples = true }: { entry: Entry; autoExamples?: boolean }) {
  const tags = [...(entry.extra?.tags ?? [])];
  const chips = tags.filter((t) => TAG_LABELS[t] ?? t.length <= 6);
  const rule = entry.rule ? RULE_LABELS[entry.rule] ?? entry.rule : null;
  const [favId, setFavId] = useState<number | null>(null);

  const toggleFav = async () => {
    if (favId !== null) {
      await removeFavorite(favId);
      setFavId(null);
    } else {
      const r = await addFavorite({
        lang: entry.lang,
        headword: entry.headword,
        norm: entry.headword,
        snapshot: { senses: entry.senses, ipa: entry.ipa },
      });
      setFavId(r.id);
    }
  };

  return (
    <article className="border-b border-zinc-200 pb-7">
      {/* 头部：词 + 读音 + 词性 + 收藏 */}
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-dict text-[30px] leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
          {entry.headword}
        </h2>
        {entry.reading && <span className="text-zinc-500">{entry.reading}</span>}
        <Ipa ipa={entry.ipa} />
        <SpeakButton text={entry.headword} lang={entry.lang} />
        {entry.pos?.map((p) => (
          <span key={p} className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            {POS_LABELS[p] ?? p}
          </span>
        ))}
        {entry.gender && (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
            {GENDER_LABELS[entry.gender] ?? entry.gender}
          </span>
        )}
        {rule && (
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-400">
            「{entry.headword}」{rule}形式
          </span>
        )}
        {entry.extra?.collins ? (
          <span className="text-xs text-amber-500">{"★".repeat(entry.extra.collins)}</span>
        ) : null}
        <button
          onClick={toggleFav}
          title="收藏到生词本"
          className={`ml-auto p-2 -m-2 text-lg leading-none transition-colors ${favId !== null ? "text-amber-400" : "text-zinc-300 hover:text-amber-400"}`}
        >
          ★
        </button>
      </header>

      {/* 释义 */}
      <div className="mt-4">
        <Senses entry={entry} />
      </div>

      {/* 标签 */}
      {(chips.length > 0 || entry.extra?.refined) && (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {chips.length > 0 && <Chips tags={chips} />}
          {entry.extra?.refined && (
            <span className="text-xs text-violet-600 dark:text-violet-400">
              ✦ AI 精修
            </span>
          )}
          {entry.extra?.source === "ai" && (
            <span className="text-xs text-violet-600 dark:text-violet-400">
              ✦ AI 词典
            </span>
          )}
        </div>
      )}

      {/* 例句（独立块，无例句不展示；前两条之外按需加载） */}
      <Examples entry={entry} auto={autoExamples} />

      <AiPanel entry={entry} />
    </article>
  );
}
