/**
 * Keyword fallback for the mock AI, used when a pasted transcript is not one of
 * the built-in fixtures. It is deliberately simple and obviously fake: it only
 * exists so the screens can be tried on any text. Real analysis is Claude's job.
 */
export interface KeywordRule {
  sub_driver_id: string;
  title: string;
  keywords: string[];
}

export const KEYWORD_RULES: KeywordRule[] = [
  { sub_driver_id: "homesickness_grief", title: "Missing home", keywords: ["miss my", "back home", "homesick"] },
  { sub_driver_id: "loneliness", title: "Feeling alone", keywords: ["alone", "lonely", "nobody", "no one to"] },
  { sub_driver_id: "shame_embarrassment", title: "Embarrassment", keywords: ["embarrass", "ashamed", "mortified"] },
  { sub_driver_id: "guilt", title: "Feeling guilty", keywords: ["guilty", "wasting", "sacrifice"] },
  { sub_driver_id: "self_doubt", title: "Doubting belonging", keywords: ["don't belong", "admitted by mistake", "not good enough"] },
  { sub_driver_id: "fear_anxiety", title: "Worry or fear", keywords: ["scared", "afraid", "worried", "anxious", "anxiety"] },
  { sub_driver_id: "frustration_resentment", title: "Frustration", keywords: ["frustrat", "angry", "unfair"] },
  { sub_driver_id: "exhaustion_burnout", title: "Tiredness", keywords: ["exhausted", "tired", "can't sleep", "don't sleep", "burnout"] },
  { sub_driver_id: "english_comprehension_expression", title: "English difficulty", keywords: ["my english", "understand the accent", "can't follow"] },
  { sub_driver_id: "academic_norms", title: "Unfamiliar academic expectations", keywords: ["office hours", "participation", "citation"] },
  { sub_driver_id: "career_norms", title: "Unsure about U.S. job norms", keywords: ["resume", "interview"] },
  { sub_driver_id: "daily_life_systems", title: "Everyday systems", keywords: ["bank account", "housing", "insurance"] },
  { sub_driver_id: "visa_work_rules", title: "Unsure about work rules", keywords: ["not understand what is allowed", "what is allowed"] },
  { sub_driver_id: "study_time_management", title: "Study time", keywords: ["study too late", "deadline", "procrastinat"] },
  { sub_driver_id: "visa_work_restrictions", title: "Limits on working", keywords: ["not allowed to work", "can't work"] },
  { sub_driver_id: "financial_strain", title: "Money pressure", keywords: ["tuition", "rent", "afford", "skip meals"] },
  { sub_driver_id: "job_market_access", title: "Job market barriers", keywords: ["sponsor", "no one will hire"] },
  { sub_driver_id: "professional_network", title: "Few professional contacts", keywords: ["don't know anyone in", "no contacts"] },
  { sub_driver_id: "family_obligations", title: "Family responsibilities", keywords: ["my mother is sick", "send money home", "my family needs"] },
  { sub_driver_id: "living_conditions", title: "Living situation", keywords: ["unsafe", "my apartment", "my dorm"] },
];
