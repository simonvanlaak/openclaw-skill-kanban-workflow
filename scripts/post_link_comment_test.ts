import { PlaneAdapter } from '../src/adapters/plane.js';

const TICKET_ID = process.env.TEST_TICKET_ID || '4b1f0794-1474-4e8c-ae26-5ba31cc96d05';
const PROJECT_ID = process.env.TEST_PROJECT_ID || '08ad0614-7ef3-4a13-9178-cf707795bf4c';
const LINK_URL = process.env.TEST_LINK_URL || 'https://docs.simonvanlaak.de/s/4EZKwcdpiBdaYGm';

async function main() {
  const a = new PlaneAdapter({
    workspaceSlug: process.env.PLANE_WORKSPACE || 'four-of-a-kind',
    projectId: PROJECT_ID,
    stageMap: {},
  });

  await a.addComment(
    TICKET_ID,
    `Links:\n1. [Nextcloud worker links test](${LINK_URL})\n\nIf this renders as a clickable link, markdown link rendering is working.`,
  );
  console.log('comment_posted');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
