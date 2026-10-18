// One seed list for generation, validation and executable documentation checks.
import { TOPIC_AND_WORKFLOW_ARTICLES } from "./corpus-articles-data.ts";
import { WORKFLOW_AND_API_ARTICLES } from "./corpus-workflows-and-api.ts";
import { PRACTICAL_GUIDES } from "./corpus-practical-guides.ts";
export const ALL_ARTICLES = [...TOPIC_AND_WORKFLOW_ARTICLES, ...WORKFLOW_AND_API_ARTICLES, ...PRACTICAL_GUIDES];
