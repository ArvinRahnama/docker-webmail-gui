/**
 * The parameter shapes {@link DmsDriver} (`types.ts`) accepts — aliases
 * onto `@dwg/shared`'s DMS request schemas, minus the `operation`
 * discriminator the transport needs and the driver does not.
 *
 * These used to be hand-written interfaces in `commands.ts`, next to the
 * argv builders that consumed them. M16 moved the builders to the broker
 * (`apps/broker/src/dms/commands.ts`) — the web tier no longer builds a
 * command line — but the *driver contract* is still the web tier's, and
 * `FakeDmsDriver` still needs to implement it. Deriving both sides from
 * the shared schema rather than re-declaring the fields here means a
 * changed parameter is a compile error in the fake, the real driver, the
 * adapter and the broker at once, instead of a silent divergence between
 * two copies of the same interface.
 */
import type {
  DmsAliasAddRequest,
  DmsAliasDeleteRequest,
  DmsDkimGenerateRequest,
  DmsEmailAddRequest,
  DmsEmailDeleteRequest,
  DmsEmailRestrictRequest,
  DmsEmailUpdateRequest,
  DmsFail2banIpRequest,
  DmsParams,
  DmsQuotaDeleteRequest,
  DmsQuotaSetRequest,
  DmsSieveActivateRequest,
  DmsSieveDeactivateRequest,
  DmsSievePutRequest,
} from '@dwg/shared';

export type AddMailboxParams = DmsParams<DmsEmailAddRequest>;
export type UpdateMailboxPasswordParams = DmsParams<DmsEmailUpdateRequest>;
export type DeleteMailboxParams = DmsParams<DmsEmailDeleteRequest>;
export type RestrictMailboxParams = DmsParams<DmsEmailRestrictRequest>;
export type AddAliasParams = DmsParams<DmsAliasAddRequest>;
export type DeleteAliasParams = DmsParams<DmsAliasDeleteRequest>;
export type SetQuotaParams = DmsParams<DmsQuotaSetRequest>;
export type DeleteQuotaParams = DmsParams<DmsQuotaDeleteRequest>;
export type ConfigDkimParams = DmsParams<DmsDkimGenerateRequest>;
export type Fail2banIpParams = DmsParams<DmsFail2banIpRequest>;
export type SieveUserParams = DmsParams<DmsSieveDeactivateRequest>;
export type SieveScriptParams = DmsParams<DmsSieveActivateRequest>;
export type SievePutParams = DmsParams<DmsSievePutRequest>;

export type { ClamdVerb, MailDataChoice, RestrictAction, RestrictScope } from '@dwg/shared';
