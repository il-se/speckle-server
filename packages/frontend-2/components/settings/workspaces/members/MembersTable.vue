<template>
  <div>
    <SettingsWorkspacesMembersTableHeader
      search-placeholder="Search members..."
      :workspace-id="workspaceId"
      :workspace="workspace"
    />
    <LayoutTable
      class="mt-6 md:mt-8 mb-12"
      :columns="[
        { id: 'name', header: 'Name', classes: 'col-span-3' },
        { id: 'company', header: 'Company', classes: 'col-span-3' },
        { id: 'verified', header: 'Status', classes: 'col-span-3' },
        { id: 'role', header: 'Role', classes: 'col-span-2' },
        {
          id: 'actions',
          header: '',
          classes: 'col-span-1 flex items-center justify-end'
        }
      ]"
      :items="members"
    >
      <template #name="{ item }">
        <div class="flex items-center gap-2">
          <UserAvatar :user="item" />
          <span class="truncate text-body-xs text-foreground">{{ item.name }}</span>
        </div>
      </template>
      <template #company="{ item }">
        <span class="text-body-xs text-foreground">
          {{ item.company ? item.company : '-' }}
        </span>
      </template>
      <template #verified="{ item }">
        <span class="text-body-xs text-foreground-2">
          {{ item.verified ? 'Verified' : 'Unverified' }}
        </span>
      </template>
      <template #role="{ item }">
        <FormSelectWorkspaceRoles
          :disabled="!isWorkspaceAdmin"
          :model-value="item.role as WorkspaceRoles"
          fully-control-value
          @update:model-value="
            (newRoleValue) => openChangeUserRoleDialog(item, newRoleValue)
          "
        />
      </template>
      <template #actions="{ item }">
        <LayoutMenu
          v-model:open="showActionsMenu[item.id]"
          :items="actionsItems"
          mount-menu-on-body
          :menu-position="HorizontalDirection.Left"
          @chosen="({ item: actionItem }) => onActionChosen(actionItem, item)"
        >
          <FormButton
            :color="showActionsMenu[item.id] ? 'outline' : 'subtle'"
            hide-text
            :icon-right="showActionsMenu[item.id] ? XMarkIcon : EllipsisHorizontalIcon"
            @click="toggleMenu(item.id)"
          />
        </LayoutMenu>
      </template>
    </LayoutTable>

    <SettingsSharedChangeRoleDialog
      v-model:open="showChangeUserRoleDialog"
      :name="userToModify?.name ?? ''"
      :old-role="oldRole"
      :new-role="newRole"
      @update-role="onUpdateRole"
    />

    <SettingsSharedDeleteUserDialog
      v-model:open="showDeleteUserRoleDialog"
      :name="userToModify?.name ?? ''"
      @remove-user="onRemoveUser"
    />
  </div>
</template>

<script setup lang="ts">
import type { WorkspaceRoles } from '@speckle/shared'
import type { SettingsWorkspacesMembersMembersTable_WorkspaceFragment } from '~~/lib/common/generated/gql/graphql'
import { graphql } from '~/lib/common/generated/gql'
import { EllipsisHorizontalIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useWorkspaceUpdateRole } from '~/lib/workspaces/composables/management'
import type { LayoutMenuItem } from '~~/lib/layout/helpers/components'
import { HorizontalDirection } from '~~/lib/common/composables/window'
import { Roles } from '@speckle/shared'

type UserItem = (typeof members)['value'][0]

graphql(`
  fragment SettingsWorkspacesMembersMembersTable_WorkspaceCollaborator on WorkspaceCollaborator {
    id
    role
    user {
      id
      avatar
      name
      company
      verified
    }
  }
`)

graphql(`
  fragment SettingsWorkspacesMembersMembersTable_Workspace on Workspace {
    id
    ...SettingsWorkspacesMembersTableHeader_Workspace
    team {
      id
      ...SettingsWorkspacesMembersMembersTable_WorkspaceCollaborator
    }
  }
`)

enum ActionTypes {
  RemoveMember = 'remove-member'
}

const props = defineProps<{
  workspace?: SettingsWorkspacesMembersMembersTable_WorkspaceFragment
  workspaceId: string
}>()

const updateUserRole = useWorkspaceUpdateRole()

const showChangeUserRoleDialog = ref(false)
const showDeleteUserRoleDialog = ref(false)
const newRole = ref<WorkspaceRoles>()
const userToModify = ref<UserItem>()

const showActionsMenu = ref<Record<string, boolean>>({})

const members = computed(() =>
  (props.workspace?.team || []).map(({ user, ...rest }) => ({
    ...user,
    ...rest
  }))
)

const oldRole = computed(() => userToModify.value?.role as WorkspaceRoles)
const isWorkspaceAdmin = computed(() => props.workspace?.role === Roles.Workspace.Admin)

const actionsItems: LayoutMenuItem[][] = [
  [{ title: 'Remove member...', id: ActionTypes.RemoveMember }]
]

const openChangeUserRoleDialog = (
  user: UserItem,
  newRoleValue?: WorkspaceRoles | WorkspaceRoles[]
) => {
  if (!newRoleValue) return
  userToModify.value = user
  newRole.value = Array.isArray(newRoleValue) ? newRoleValue[0] : newRoleValue
  showChangeUserRoleDialog.value = true
}

const openDeleteUserRoleDialog = (user: UserItem) => {
  userToModify.value = user
  showDeleteUserRoleDialog.value = true
}

const onUpdateRole = async () => {
  if (!userToModify.value || !newRole.value) return

  await updateUserRole({
    userId: userToModify.value.id,
    role: newRole.value,
    workspaceId: props.workspaceId
  })
}

const onRemoveUser = async () => {
  if (!userToModify.value?.id) return

  await updateUserRole({
    userId: userToModify.value.id,
    role: null,
    workspaceId: props.workspaceId
  })
}

const onActionChosen = (actionItem: LayoutMenuItem, user: UserItem) => {
  userToModify.value = user

  switch (actionItem.id) {
    case ActionTypes.RemoveMember:
      openDeleteUserRoleDialog(user)
      break
  }
}

const toggleMenu = (itemId: string) => {
  showActionsMenu.value[itemId] = !showActionsMenu.value[itemId]
}
</script>
