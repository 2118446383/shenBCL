import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogIconUrl } from '../arcane-launcher/src/shared/catalog-icon';
import { CatalogService } from '../arcane-launcher/src/main/services/catalog';

test('catalog icons accept project CDN images and reject active, private, or unrelated image addresses', () => {
  for (const extension of ['png', 'webp', 'jpg', 'jpeg', 'gif', 'avif', 'svg']) {
    const url = `https://cdn.modrinth.com/data/ProjectA/icon.${extension}`;
    assert.equal(catalogIconUrl(url, 'ProjectA'), url);
  }
  for (const value of [
    undefined, null, 4, '', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)',
    'http://cdn.modrinth.com/data/ProjectA/icon.png',
    'https://cdn.modrinth.com.evil.example/data/ProjectA/icon.png',
    'https://127.0.0.1/data/ProjectA/icon.png',
    'https://username:secret@cdn.modrinth.com/data/ProjectA/icon.png',
    'https://cdn.modrinth.com:444/data/ProjectA/icon.png',
    'https://cdn.modrinth.com/data/ProjectA/icon.html',
    'https://cdn.modrinth.com/data/ProjectA/icon.png?tracking=private',
    'https://cdn.modrinth.com/data/ProjectA/icon.svg#fragment',
    'https://cdn.modrinth.com/data/OtherProject/icon.png',
    'https://cdn.modrinth.com/data/ProjectA/../OtherProject/icon.png',
  ]) assert.equal(catalogIconUrl(value, 'ProjectA'), undefined, String(value));
});

test('mod and modpack search preserve trusted project icons without discarding projects with invalid or missing images', async () => {
  for (const type of ['mod', 'modpack'] as const) {
    const service = new CatalogService({ fetch: async () => new Response(JSON.stringify({ total_hits: 3, hits: [
      { project_id: 'ProjectA', slug: 'project-a', project_type: type, title: 'Project A', icon_url: 'https://cdn.modrinth.com/data/ProjectA/icon.webp' },
      { project_id: 'ProjectB', slug: 'project-b', project_type: type, title: 'Project B', icon_url: 'https://evil.example/track.png' },
      { project_id: 'ProjectC', slug: 'project-c', project_type: type, title: 'Project C', icon_url: '' },
    ] }), { headers: { 'content-type': 'application/json' } }) });
    const result = await service.search({ type, query: '' });
    assert.equal(result.hits.length, 3);
    assert.equal(result.hits[0].iconUrl, 'https://cdn.modrinth.com/data/ProjectA/icon.webp');
    assert.equal(result.hits[1].iconUrl, undefined);
    assert.equal(result.hits[2].iconUrl, undefined);
    assert.doesNotMatch(JSON.stringify(result), /evil\.example/);
  }
});
