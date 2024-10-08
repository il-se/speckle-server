import { db } from '@/db/knex'
import { Resolvers } from '@/modules/core/graph/generated/graphql'
import { removePrivateFields } from '@/modules/core/helpers/userHelper'
import {
  getStream,
  getUserStreams,
  getUserStreamsCount,
  grantStreamPermissions,
  grantStreamPermissionsFactory,
  revokeStreamPermissionsFactory
} from '@/modules/core/repositories/streams'
import { getUser, getUsers } from '@/modules/core/repositories/users'
import { getStreams } from '@/modules/core/services/streams'
import { InviteCreateValidationError } from '@/modules/serverinvites/errors'
import {
  deleteAllResourceInvitesFactory,
  deleteInviteFactory,
  deleteInvitesByTargetFactory,
  deleteServerOnlyInvitesFactory,
  findInviteFactory,
  findUserByTargetFactory,
  insertInviteAndDeleteOldFactory,
  markInviteUpdatedfactory,
  queryAllResourceInvitesFactory,
  queryAllUserResourceInvitesFactory,
  updateAllInviteTargetsFactory
} from '@/modules/serverinvites/repositories/serverInvites'
import { buildCoreInviteEmailContentsFactory } from '@/modules/serverinvites/services/coreEmailContents'
import { collectAndValidateCoreTargetsFactory } from '@/modules/serverinvites/services/coreResourceCollection'
import {
  createAndSendInviteFactory,
  resendInviteEmailFactory
} from '@/modules/serverinvites/services/creation'
import {
  cancelResourceInviteFactory,
  finalizeInvitedServerRegistrationFactory,
  finalizeResourceInviteFactory
} from '@/modules/serverinvites/services/processing'
import { createProjectInviteFactory } from '@/modules/serverinvites/services/projectInviteManagement'
import { getInvitationTargetUsersFactory } from '@/modules/serverinvites/services/retrieval'
import { authorizeResolver } from '@/modules/shared'
import { withTransaction } from '@/modules/shared/helpers/dbHelper'
import { getFeatureFlags } from '@/modules/shared/helpers/envHelper'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { WorkspaceInviteResourceType } from '@/modules/workspaces/domain/constants'
import {
  WorkspaceInvalidRoleError,
  WorkspaceJoinNotAllowedError,
  WorkspaceNotFoundError,
  WorkspacesNotAuthorizedError,
  WorkspacesNotYetImplementedError
} from '@/modules/workspaces/errors/workspace'
import { isWorkspaceRole } from '@/modules/workspaces/helpers/roles'
import {
  deleteWorkspaceFactory as repoDeleteWorkspaceFactory,
  deleteWorkspaceRoleFactory as repoDeleteWorkspaceRoleFactory,
  getWorkspaceCollaboratorsFactory,
  getWorkspaceFactory,
  getWorkspaceRolesFactory,
  getWorkspaceRolesForUserFactory,
  upsertWorkspaceFactory,
  upsertWorkspaceRoleFactory,
  workspaceInviteValidityFilter,
  storeWorkspaceDomainFactory,
  deleteWorkspaceDomainFactory,
  getWorkspaceDomainsFactory,
  getUserDiscoverableWorkspacesFactory,
  getWorkspaceWithDomainsFactory,
  countProjectsVersionsByWorkspaceIdFactory
} from '@/modules/workspaces/repositories/workspaces'
import {
  buildWorkspaceInviteEmailContentsFactory,
  collectAndValidateWorkspaceTargetsFactory,
  createWorkspaceInviteFactory,
  getPendingWorkspaceCollaboratorsFactory,
  getUserPendingWorkspaceInviteFactory,
  getUserPendingWorkspaceInvitesFactory,
  processFinalizedWorkspaceInviteFactory,
  validateWorkspaceInviteBeforeFinalizationFactory
} from '@/modules/workspaces/services/invites'
import {
  addDomainToWorkspaceFactory,
  createWorkspaceFactory,
  deleteWorkspaceFactory,
  deleteWorkspaceRoleFactory,
  updateWorkspaceFactory,
  updateWorkspaceRoleFactory
} from '@/modules/workspaces/services/management'
import {
  getWorkspaceProjectsFactory,
  queryAllWorkspaceProjectsFactory
} from '@/modules/workspaces/services/projects'
import {
  getDiscoverableWorkspacesForUserFactory,
  getWorkspacesForUserFactory
} from '@/modules/workspaces/services/retrieval'
import { Roles, WorkspaceRoles, removeNullOrUndefinedKeys } from '@speckle/shared'
import { chunk } from 'lodash'
import { deleteStream } from '@/modules/core/repositories/streams'
import {
  findEmailsByUserIdFactory,
  findVerifiedEmailsByUserIdFactory,
  createUserEmailFactory,
  ensureNoPrimaryEmailForUserFactory,
  findEmailFactory
} from '@/modules/core/repositories/userEmails'
import { joinWorkspaceFactory } from '@/modules/workspaces/services/join'
import { validateAndCreateUserEmailFactory } from '@/modules/core/services/userEmails'
import { requestNewEmailVerification } from '@/modules/emails/services/verification/request'
import { Workspace } from '@/modules/workspacesCore/domain/types'
import { WORKSPACE_MAX_PROJECTS_VERSIONS } from '@/modules/gatekeeper/domain/constants'

const buildCreateAndSendServerOrProjectInvite = () =>
  createAndSendInviteFactory({
    findUserByTarget: findUserByTargetFactory(),
    insertInviteAndDeleteOld: insertInviteAndDeleteOldFactory({ db }),
    collectAndValidateResourceTargets: collectAndValidateCoreTargetsFactory({
      getStream
    }),
    buildInviteEmailContents: buildCoreInviteEmailContentsFactory({
      getStream
    }),
    emitEvent: ({ eventName, payload }) =>
      getEventBus().emit({
        eventName,
        payload
      })
  })

const buildCreateAndSendWorkspaceInvite = () =>
  createAndSendInviteFactory({
    findUserByTarget: findUserByTargetFactory(),
    insertInviteAndDeleteOld: insertInviteAndDeleteOldFactory({ db }),
    collectAndValidateResourceTargets: collectAndValidateWorkspaceTargetsFactory({
      getStream,
      getWorkspace: getWorkspaceFactory({ db }),
      getWorkspaceDomains: getWorkspaceDomainsFactory({ db }),
      findVerifiedEmailsByUserId: findVerifiedEmailsByUserIdFactory({ db })
    }),
    buildInviteEmailContents: buildWorkspaceInviteEmailContentsFactory({
      getStream,
      getWorkspace: getWorkspaceFactory({ db })
    }),
    emitEvent: ({ eventName, payload }) =>
      getEventBus().emit({
        eventName,
        payload
      })
  })

const { FF_WORKSPACES_MODULE_ENABLED } = getFeatureFlags()

export = FF_WORKSPACES_MODULE_ENABLED
  ? ({
      Query: {
        workspace: async (_parent, args, ctx) => {
          const workspace = await ctx.loaders.workspaces!.getWorkspace.load(args.id)
          if (!workspace) {
            throw new WorkspaceNotFoundError()
          }

          await authorizeResolver(
            ctx.userId,
            args.id,
            Roles.Workspace.Guest,
            ctx.resourceAccessRules
          )

          return workspace
        },
        workspaceInvite: async (_parent, args, ctx) => {
          const getPendingInvite = getUserPendingWorkspaceInviteFactory({
            findInvite: findInviteFactory({
              db,
              filterQuery: workspaceInviteValidityFilter
            }),
            getUser
          })

          return await getPendingInvite({
            userId: ctx.userId!,
            token: args.token,
            workspaceId: args.workspaceId
          })
        }
      },
      Mutation: {
        workspaceMutations: () => ({})
      },
      ProjectInviteMutations: {
        async createForWorkspace(_parent, args, ctx) {
          await authorizeResolver(
            ctx.userId,
            args.projectId,
            Roles.Stream.Owner,
            ctx.resourceAccessRules
          )

          const inviteCount = args.inputs.length
          if (inviteCount > 10 && ctx.role !== Roles.Server.Admin) {
            throw new InviteCreateValidationError(
              'Maximum 10 invites can be sent at once by non admins'
            )
          }

          const createProjectInvite = createProjectInviteFactory({
            createAndSendInvite: buildCreateAndSendServerOrProjectInvite()
          })

          const inputBatches = chunk(args.inputs, 10)
          for (const batch of inputBatches) {
            await Promise.all(
              batch.map((i) => {
                const workspaceRole = i.workspaceRole
                if (
                  workspaceRole &&
                  !(Object.values(Roles.Workspace) as string[]).includes(workspaceRole)
                ) {
                  throw new InviteCreateValidationError(
                    'Invalid workspace role specified: ' + workspaceRole
                  )
                }

                return createProjectInvite({
                  input: {
                    ...i,
                    projectId: args.projectId
                  },
                  inviterId: ctx.userId!,
                  inviterResourceAccessRules: ctx.resourceAccessRules,
                  secondaryResourceRoles: workspaceRole
                    ? {
                        [WorkspaceInviteResourceType]: workspaceRole as WorkspaceRoles
                      }
                    : undefined
                })
              })
            )
          }
          return ctx.loaders.streams.getStream.load(args.projectId)
        }
      },
      WorkspaceMutations: {
        create: async (_parent, args, context) => {
          const { name, description, defaultLogoIndex, logo } = args.input

          const createWorkspace = createWorkspaceFactory({
            upsertWorkspace: upsertWorkspaceFactory({ db }),
            upsertWorkspaceRole: upsertWorkspaceRoleFactory({ db }),
            emitWorkspaceEvent: getEventBus().emit
          })

          const workspace = await createWorkspace({
            userId: context.userId!,
            workspaceInput: {
              name,
              description: description ?? null,
              logo: logo ?? null,
              defaultLogoIndex: defaultLogoIndex ?? 0
            },
            userResourceAccessLimits: context.resourceAccessRules
          })

          return workspace
        },
        delete: async (_parent, args, context) => {
          const { workspaceId } = args

          await authorizeResolver(
            context.userId!,
            workspaceId,
            Roles.Workspace.Admin,
            context.resourceAccessRules
          )

          // Delete workspace and associated resources (i.e. invites)
          const deleteWorkspace = deleteWorkspaceFactory({
            deleteWorkspace: repoDeleteWorkspaceFactory({ db }),
            deleteProject: deleteStream,
            deleteAllResourceInvites: deleteAllResourceInvitesFactory({ db }),
            queryAllWorkspaceProjects: queryAllWorkspaceProjectsFactory({ getStreams })
          })

          await deleteWorkspace({ workspaceId })

          return true
        },
        update: async (_parent, args, context) => {
          const { id: workspaceId, ...workspaceInput } = args.input

          await authorizeResolver(
            context.userId!,
            workspaceId,
            Roles.Workspace.Admin,
            context.resourceAccessRules
          )

          const updateWorkspace = updateWorkspaceFactory({
            getWorkspace: getWorkspaceFactory({ db }),
            upsertWorkspace: upsertWorkspaceFactory({ db }),
            emitWorkspaceEvent: getEventBus().emit
          })

          const workspace = await updateWorkspace({
            workspaceId,
            workspaceInput
          })

          return workspace
        },
        updateRole: async (_parent, args, context) => {
          const { userId, workspaceId, role } = args.input

          await authorizeResolver(
            context.userId,
            workspaceId,
            Roles.Workspace.Admin,
            context.resourceAccessRules
          )

          if (!role) {
            const trx = await db.transaction()

            const deleteWorkspaceRole = deleteWorkspaceRoleFactory({
              deleteWorkspaceRole: repoDeleteWorkspaceRoleFactory({ db: trx }),
              getWorkspaceRoles: getWorkspaceRolesFactory({ db: trx }),
              revokeStreamPermissions: revokeStreamPermissionsFactory({ db: trx }),
              emitWorkspaceEvent: getEventBus().emit,
              getStreams
            })

            await withTransaction(deleteWorkspaceRole(args.input), trx)
          } else {
            if (!isWorkspaceRole(role)) {
              throw new WorkspaceInvalidRoleError()
            }

            const trx = await db.transaction()

            const updateWorkspaceRole = updateWorkspaceRoleFactory({
              upsertWorkspaceRole: upsertWorkspaceRoleFactory({ db: trx }),
              getWorkspaceWithDomains: getWorkspaceWithDomainsFactory({ db: trx }),
              findVerifiedEmailsByUserId: findVerifiedEmailsByUserIdFactory({
                db: trx
              }),
              getWorkspaceRoles: getWorkspaceRolesFactory({ db: trx }),
              grantStreamPermissions: grantStreamPermissionsFactory({ db: trx }),
              emitWorkspaceEvent: getEventBus().emit,
              getStreams
            })

            await withTransaction(
              updateWorkspaceRole({ userId, workspaceId, role }),
              trx
            )
          }

          return await getWorkspaceFactory({ db })({ workspaceId })
        },
        addDomain: async (_parent, args, context) => {
          await authorizeResolver(
            context.userId!,
            args.input.workspaceId,
            Roles.Workspace.Admin,
            context.resourceAccessRules
          )

          await addDomainToWorkspaceFactory({
            getWorkspace: getWorkspaceFactory({ db }),
            findEmailsByUserId: findEmailsByUserIdFactory({ db }),
            storeWorkspaceDomain: storeWorkspaceDomainFactory({ db }),
            upsertWorkspace: upsertWorkspaceFactory({ db }),
            getDomains: getWorkspaceDomainsFactory({ db }),
            emitWorkspaceEvent: getEventBus().emit
          })({
            workspaceId: args.input.workspaceId,
            userId: context.userId!,
            domain: args.input.domain
          })

          return await getWorkspaceFactory({ db })({
            workspaceId: args.input.workspaceId,
            userId: context.userId
          })
        },
        async deleteDomain(_parent, args, context) {
          await authorizeResolver(
            context.userId!,
            args.input.workspaceId,
            Roles.Workspace.Admin,
            context.resourceAccessRules
          )
          await deleteWorkspaceDomainFactory({ db })({ id: args.input.id })
          return await getWorkspaceFactory({ db })({
            workspaceId: args.input.workspaceId,
            userId: context.userId
          })
        },
        async join(_parent, args, context) {
          if (!context.userId) throw new WorkspaceJoinNotAllowedError()

          await joinWorkspaceFactory({
            getUserEmails: findEmailsByUserIdFactory({ db }),
            getWorkspaceWithDomains: getWorkspaceWithDomainsFactory({ db }),
            insertWorkspaceRole: upsertWorkspaceRoleFactory({ db }),
            emitWorkspaceEvent: getEventBus().emit
          })({ userId: context.userId, workspaceId: args.input.workspaceId })

          return await getWorkspaceFactory({ db })({
            workspaceId: args.input.workspaceId,
            userId: context.userId
          })
        },
        leave: async (_parent, args, context) => {
          const trx = await db.transaction()

          const deleteWorkspaceRole = deleteWorkspaceRoleFactory({
            deleteWorkspaceRole: repoDeleteWorkspaceRoleFactory({ db: trx }),
            getWorkspaceRoles: getWorkspaceRolesFactory({ db: trx }),
            revokeStreamPermissions: revokeStreamPermissionsFactory({ db: trx }),
            emitWorkspaceEvent: getEventBus().emit,
            getStreams
          })

          await withTransaction(
            deleteWorkspaceRole({ workspaceId: args.id, userId: context.userId! }),
            trx
          )

          return true
        },
        invites: () => ({})
      },
      WorkspaceInviteMutations: {
        resend: async (_parent, args, ctx) => {
          const {
            input: { inviteId, workspaceId }
          } = args

          await authorizeResolver(
            ctx.userId!,
            workspaceId,
            Roles.Workspace.Admin,
            ctx.resourceAccessRules
          )

          const resendInviteEmail = resendInviteEmailFactory({
            buildInviteEmailContents: buildWorkspaceInviteEmailContentsFactory({
              getStream,
              getWorkspace: getWorkspaceFactory({ db })
            }),
            findUserByTarget: findUserByTargetFactory(),
            findInvite: findInviteFactory({ db }),
            markInviteUpdated: markInviteUpdatedfactory({ db })
          })

          await resendInviteEmail({
            inviteId,
            resourceFilter: {
              resourceType: WorkspaceInviteResourceType,
              resourceId: workspaceId
            }
          })

          return true
        },
        create: async (_parent, args, ctx) => {
          const createInvite = createWorkspaceInviteFactory({
            createAndSendInvite: buildCreateAndSendWorkspaceInvite()
          })
          await createInvite({
            workspaceId: args.workspaceId,
            input: args.input,
            inviterId: ctx.userId!,
            inviterResourceAccessRules: ctx.resourceAccessRules
          })

          return ctx.loaders.workspaces!.getWorkspace.load(args.workspaceId)
        },
        batchCreate: async (_parent, args, ctx) => {
          const inviteCount = args.input.length
          if (inviteCount > 10 && ctx.role !== Roles.Server.Admin) {
            throw new InviteCreateValidationError(
              'Maximum 10 invites can be sent at once by non admins'
            )
          }

          const createInvite = createWorkspaceInviteFactory({
            createAndSendInvite: buildCreateAndSendWorkspaceInvite()
          })

          const inputBatches = chunk(args.input, 10)
          for (const batch of inputBatches) {
            await Promise.all(
              batch.map((i) =>
                createInvite({
                  workspaceId: args.workspaceId,
                  input: i,
                  inviterId: ctx.userId!,
                  inviterResourceAccessRules: ctx.resourceAccessRules
                })
              )
            )
          }

          return ctx.loaders.workspaces!.getWorkspace.load(args.workspaceId)
        },
        use: async (_parent, args, ctx) => {
          const finalizeInvite = finalizeResourceInviteFactory({
            findInvite: findInviteFactory({ db }),
            deleteInvitesByTarget: deleteInvitesByTargetFactory({ db }),
            insertInviteAndDeleteOld: insertInviteAndDeleteOldFactory({ db }),
            emitEvent: ({ eventName, payload }) =>
              getEventBus().emit({
                eventName,
                payload
              }),
            validateInvite: validateWorkspaceInviteBeforeFinalizationFactory({
              getWorkspace: getWorkspaceFactory({ db })
            }),
            processInvite: processFinalizedWorkspaceInviteFactory({
              getWorkspace: getWorkspaceFactory({ db }),
              updateWorkspaceRole: updateWorkspaceRoleFactory({
                getWorkspaceWithDomains: getWorkspaceWithDomainsFactory({ db }),
                findVerifiedEmailsByUserId: findVerifiedEmailsByUserIdFactory({ db }),
                getWorkspaceRoles: getWorkspaceRolesFactory({ db }),
                upsertWorkspaceRole: upsertWorkspaceRoleFactory({ db }),
                emitWorkspaceEvent: ({ eventName, payload }) =>
                  getEventBus().emit({
                    eventName,
                    payload
                  }),
                getStreams,
                grantStreamPermissions
              })
            }),
            findEmail: findEmailFactory({ db }),
            validateAndCreateUserEmail: validateAndCreateUserEmailFactory({
              createUserEmail: createUserEmailFactory({ db }),
              ensureNoPrimaryEmailForUser: ensureNoPrimaryEmailForUserFactory({ db }),
              findEmail: findEmailFactory({ db }),
              updateEmailInvites: finalizeInvitedServerRegistrationFactory({
                deleteServerOnlyInvites: deleteServerOnlyInvitesFactory({ db }),
                updateAllInviteTargets: updateAllInviteTargetsFactory({ db })
              }),
              requestNewEmailVerification
            })
          })

          await finalizeInvite({
            finalizerUserId: ctx.userId!,
            finalizerResourceAccessLimits: ctx.resourceAccessRules,
            token: args.input.token,
            accept: args.input.accept,
            resourceType: WorkspaceInviteResourceType,
            allowAttachingNewEmail: args.input.addNewEmail ?? undefined
          })

          return true
        },
        cancel: async (_parent, args, ctx) => {
          await authorizeResolver(
            ctx.userId,
            args.workspaceId,
            Roles.Workspace.Admin,
            ctx.resourceAccessRules
          )

          const cancelInvite = cancelResourceInviteFactory({
            findInvite: findInviteFactory({ db }),
            deleteInvite: deleteInviteFactory({ db }),
            validateResourceAccess: validateWorkspaceInviteBeforeFinalizationFactory({
              getWorkspace: getWorkspaceFactory({ db })
            })
          })

          await cancelInvite({
            resourceId: args.workspaceId,
            inviteId: args.inviteId,
            cancelerId: ctx.userId!,
            resourceType: WorkspaceInviteResourceType,
            cancelerResourceAccessLimits: ctx.resourceAccessRules
          })
          return ctx.loaders.workspaces!.getWorkspace.load(args.workspaceId)
        }
      },
      Workspace: {
        role: async (parent, _args, ctx) => {
          const workspace = await ctx.loaders.workspaces!.getWorkspace.load(parent.id)
          return workspace?.role || null
        },
        team: async (parent, args) => {
          const getTeam = getWorkspaceCollaboratorsFactory({ db })
          const collaborators = await getTeam({
            workspaceId: parent.id,
            filter: removeNullOrUndefinedKeys(args?.filter ?? {})
          })

          return collaborators
        },
        invitedTeam: async (parent, args) => {
          const getPendingTeam = getPendingWorkspaceCollaboratorsFactory({
            queryAllResourceInvites: queryAllResourceInvitesFactory({
              db,
              filterQuery: workspaceInviteValidityFilter
            }),
            getInvitationTargetUsers: getInvitationTargetUsersFactory({ getUsers })
          })

          return await getPendingTeam({ workspaceId: parent.id, filter: args.filter })
        },
        projects: async (parent, args, ctx) => {
          if (!ctx.userId) return []
          const getWorkspaceProjects = getWorkspaceProjectsFactory({
            getStreams: getUserStreams
          })
          const filter = {
            ...(args.filter || {}),
            userId: ctx.userId,
            workspaceId: parent.id
          }
          const { items, cursor } = await getWorkspaceProjects(
            {
              workspaceId: parent.id
            },
            {
              limit: args.limit || 25,
              cursor: args.cursor || null,
              filter
            }
          )
          return {
            items,
            cursor,
            totalCount: await getUserStreamsCount(filter)
          }
        },
        domains: async (parent) => {
          return await getWorkspaceDomainsFactory({ db })({ workspaceIds: [parent.id] })
        },
        billing: (parent) => ({ parent })
      },
      WorkspaceBilling: {
        versionsCount: async (parent) => {
          return {
            current: await countProjectsVersionsByWorkspaceIdFactory({ db })({
              workspaceId: (parent as { parent: Workspace }).parent.id
            }),
            max: WORKSPACE_MAX_PROJECTS_VERSIONS
          }
        }
      },
      WorkspaceCollaborator: {
        user: async (parent) => {
          return parent
        },
        role: async (parent) => {
          return parent.workspaceRole
        }
      },
      PendingWorkspaceCollaborator: {
        workspaceName: async (parent, _args, ctx) => {
          const workspace = await ctx.loaders.workspaces!.getWorkspace.load(
            parent.workspaceId
          )
          return workspace!.name
        },
        invitedBy: async (parent, _args, ctx) => {
          const { invitedById } = parent
          if (!invitedById) return null

          const user = await ctx.loaders.users.getUser.load(invitedById)
          return user ? removePrivateFields(user) : null
        },
        token: async (parent, _args, ctx) => {
          // If it was specified with the request, just return it
          if (parent.token?.length) return parent.token

          const authedUserId = ctx.userId
          const targetUserId = parent.user?.id
          const inviteId = parent.inviteId

          // Only returning it for the user that is the pending stream collaborator
          if (!authedUserId || !targetUserId || authedUserId !== targetUserId) {
            return null
          }

          const invite = await ctx.loaders.invites.getInvite.load(inviteId)
          return invite?.token || null
        },
        email: async (parent, _args, ctx) => {
          if (!parent.user) return parent.email

          // TODO: Tests to check token & email access?

          const token = parent.token
          const authedUserId = ctx.userId
          const targetUserId = parent.user?.id

          // Only returning it for the user that is the pending stream collaborator
          // OR if the token was specified
          if (
            (!authedUserId || !targetUserId || authedUserId !== targetUserId) &&
            !token
          ) {
            return null
          }

          return parent.email
        }
      },
      User: {
        discoverableWorkspaces: async (_parent, _args, context) => {
          if (!context.userId) {
            throw new WorkspacesNotAuthorizedError()
          }

          const getDiscoverableWorkspacesForUser =
            getDiscoverableWorkspacesForUserFactory({
              findEmailsByUserId: findEmailsByUserIdFactory({ db }),
              getDiscoverableWorkspaces: getUserDiscoverableWorkspacesFactory({ db })
            })

          return await getDiscoverableWorkspacesForUser({ userId: context.userId })
        },
        workspaces: async (_parent, _args, context) => {
          if (!context.userId) {
            throw new WorkspacesNotAuthorizedError()
          }

          const getWorkspace = getWorkspaceFactory({ db })
          const getWorkspaceRolesForUser = getWorkspaceRolesForUserFactory({ db })

          const getWorkspacesForUser = getWorkspacesForUserFactory({
            getWorkspace,
            getWorkspaceRolesForUser
          })

          const workspaces = await getWorkspacesForUser({ userId: context.userId })

          // TODO: Pagination
          return {
            items: workspaces,
            totalCount: workspaces.length
          }
        },
        workspaceInvites: async (parent) => {
          const getInvites = getUserPendingWorkspaceInvitesFactory({
            getUser,
            getUserResourceInvites: queryAllUserResourceInvitesFactory({
              db,
              filterQuery: workspaceInviteValidityFilter
            })
          })

          return await getInvites(parent.id)
        }
      },
      Project: {
        workspace: async (parent, _args, context) => {
          if (!parent.workspaceId) {
            return null
          }

          const workspace = await context.loaders.workspaces!.getWorkspace.load(
            parent.workspaceId
          )
          if (!workspace) {
            throw new WorkspaceNotFoundError()
          }

          await authorizeResolver(
            context.userId,
            parent.workspaceId,
            Roles.Workspace.Guest,
            context.resourceAccessRules
          )

          return workspace
        }
      },
      AdminQueries: {
        workspaceList: async () => {
          throw new WorkspacesNotYetImplementedError()
        }
      }
    } as Resolvers)
  : {}
