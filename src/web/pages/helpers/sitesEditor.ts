export type SiteForm = {
  name: string;
  url: string;
  externalCheckinUrl: string;
  platform: string;
  proxyUrl: string;
  globalWeight: string;
};

export type SiteEditorState =
  | { mode: 'add' }
  | { mode: 'edit'; editingSiteId: number };

type SiteSaveAction =
  | { kind: 'add'; payload: SiteForm }
  | { kind: 'update'; id: number; payload: SiteForm };

export function emptySiteForm(): SiteForm {
  return { name: '', url: '', externalCheckinUrl: '', platform: '', proxyUrl: '', globalWeight: '1' };
}

export function siteFormFromSite(site: Partial<SiteForm> & {
  proxyUrl?: string | null;
  externalCheckinUrl?: string | null;
  globalWeight?: number | string | null;
}): SiteForm {
  const globalWeightRaw = Number(site.globalWeight);
  const globalWeight = Number.isFinite(globalWeightRaw) && globalWeightRaw > 0 ? String(globalWeightRaw) : '1';
  return {
    name: site.name ?? '',
    url: site.url ?? '',
    externalCheckinUrl: site.externalCheckinUrl ?? '',
    platform: site.platform ?? '',
    proxyUrl: site.proxyUrl ?? '',
    globalWeight,
  };
}

export function buildSiteSaveAction(editor: SiteEditorState, form: SiteForm): SiteSaveAction {
  if (editor.mode === 'edit') {
    if (!Number.isFinite(editor.editingSiteId)) {
      throw new Error('editingSiteId is required in edit mode');
    }
    return { kind: 'update', id: editor.editingSiteId, payload: form };
  }
  return { kind: 'add', payload: form };
}
