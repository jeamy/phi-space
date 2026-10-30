// One seed list for generation, validation and executable documentation checks.
import { TOPIC_AND_WORKFLOW_ARTICLES } from "./corpus-articles-data.ts";
import { WORKFLOW_AND_API_ARTICLES } from "./corpus-workflows-and-api.ts";
import { PRACTICAL_GUIDES } from "./corpus-practical-guides.ts";
import { EXAMPLE_AND_APP_ARTICLES } from "./corpus-examples-and-apps.ts";
export const ALL_ARTICLES = [...TOPIC_AND_WORKFLOW_ARTICLES, ...WORKFLOW_AND_API_ARTICLES, ...PRACTICAL_GUIDES, ...EXAMPLE_AND_APP_ARTICLES];
