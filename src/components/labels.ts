// 词性 / 变形规则 / 标签的中文显示
export const POS_LABELS: Record<string, string> = {
  n: "名", v: "动", adj: "形", adv: "副", prep: "介", pron: "代", conj: "连",
  art: "冠", int: "叹", num: "数", abbr: "缩", aux: "助", modal: "情态",
};

export const RULE_LABELS: Record<string, string> = {
  pl: "复数", past: "过去式", pp: "过去分词", ing: "现在分词", s3: "三单",
  comp: "比较级", sup: "最高级", lemma: "原形",
};

export const TAG_LABELS: Record<string, string> = {
  zk: "中考", gk: "高考", cet4: "CET4", cet6: "CET6", ky: "考研", toefl: "TOEFL",
  ielts: "IELTS", gre: "GRE", oxford: "牛津3000",
};

export const GENDER_LABELS: Record<string, string> = { m: "阳性", f: "阴性" };
