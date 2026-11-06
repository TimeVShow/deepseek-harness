/** The sidebar's Agent Flow entry icon; the sidebar owns the button, label, and selected state around it. */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the branch glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function AgentFlowPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconBranchOutlineRegular size={size} />
}
