<template>
  <LayoutDialog
    v-model:open="isOpen"
    title="Delete workspace"
    max-width="sm"
    :buttons="dialogButtons"
  >
    <p class="text-body-xs text-foreground">
      Are you sure you want to
      <span class="font-medium">permanently delete</span>
      the selected workspace?
    </p>
    <div
      class="rounded border bg-foundation-2 border-outline-3 text-body-2xs text-foreground font-medium py-3 px-4 my-4"
    >
      {{ workspace.name }}
    </div>
    <p class="text-body-xs text-foreground">
      This action
      <span class="font-medium">cannot</span>
      be undone.
    </p>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { graphql } from '~~/lib/common/generated/gql'
import type {
  SettingsWorkspaceGeneralDeleteDialog_WorkspaceFragment,
  UserWorkspacesArgs,
  User
} from '~/lib/common/generated/gql/graphql'
import type { LayoutDialogButton } from '@speckle/ui-components'
import { useMutation, useApolloClient } from '@vue/apollo-composable'
import { deleteWorkspaceMutation } from '~/lib/settings/graphql/mutations'
import {
  convertThrowIntoFetchResult,
  getFirstErrorMessage,
  getCacheId,
  modifyObjectFields
} from '~~/lib/common/helpers/graphql'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import { useActiveUser } from '~~/lib/auth/composables/activeUser'
import { isUndefined } from 'lodash-es'

graphql(`
  fragment SettingsWorkspaceGeneralDeleteDialog_Workspace on Workspace {
    id
    name
  }
`)

const props = defineProps<{
  workspace: SettingsWorkspaceGeneralDeleteDialog_WorkspaceFragment
}>()

const isOpen = defineModel<boolean>('open', { required: true })

const { mutate: deleteWorkspace } = useMutation(deleteWorkspaceMutation)
const { triggerNotification } = useGlobalToast()
const { activeUser } = useActiveUser()
const apollo = useApolloClient().client

const onDelete = async () => {
  isOpen.value = false

  const cache = apollo.cache
  const result = await deleteWorkspace({
    workspaceId: props.workspace.id
  }).catch(convertThrowIntoFetchResult)

  if (result?.data) {
    if (activeUser.value) {
      cache.evict({
        id: getCacheId('Workspace', props.workspace.id)
      })

      modifyObjectFields<UserWorkspacesArgs, User['workspaces']>(
        cache,
        activeUser.value.id,
        (_fieldName, variables, value, { DELETE }) => {
          if (variables?.filter?.search?.length) return DELETE

          const newTotalCount = isUndefined(value?.totalCount)
            ? undefined
            : Math.max(0, (value?.totalCount || 0) - 1)

          return {
            ...value,
            ...(isUndefined(newTotalCount) ? {} : { totalCount: newTotalCount })
          }
        },
        { fieldNameWhitelist: ['workspaces'] }
      )
    }

    triggerNotification({
      type: ToastNotificationType.Success,
      title: 'Workspace deleted',
      description: `The ${props.workspace.name} workspace has been deleted`
    })
  } else {
    const errorMessage = getFirstErrorMessage(result?.errors)
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Failed to delete workspace',
      description: errorMessage
    })
  }
}

const dialogButtons = computed((): LayoutDialogButton[] => [
  {
    text: 'Cancel',
    props: { color: 'outline', fullWidth: true },
    onClick: () => {
      isOpen.value = false
    }
  },
  {
    text: 'Delete',
    props: {
      fullWidth: true,
      color: 'danger'
    },
    onClick: onDelete
  }
])
</script>
