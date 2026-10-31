// Defense in depth: apply before every static-asset lookup, on every hostname.
export function isPrivateAssetPath(pathname) {
    let path;
    try { path = decodeURIComponent(pathname).replace(/\\/g, '/'); }
    catch { return true; }
    const segments = path.split('/').filter(Boolean);
    if (segments.some(part => part.startsWith('.') && part !== '.well-known')) return true;
    if (segments.slice(0, 3).map(part => part.toLowerCase()).join('/') === 'site/info/new_info') return true;
    if (/^(aws|scripts|worker|functions|tests|docs|migrations|node_modules)$/i.test(segments[0] || '')) return true;
    const filename = segments.at(-1) || '';
    return /^(wrangler\.(jsonc?|toml)|package(-lock)?\.json|AGENTS\.md|README.*|secret(s)?\.json)$/i.test(filename)
        || /\.(py|pyc|pem|key|env|sql|toml|ya?ml|bak|log)$/i.test(filename);
}
