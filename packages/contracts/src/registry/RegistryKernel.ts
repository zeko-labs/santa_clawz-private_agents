import {
  Field,
  Permissions,
  SmartContract,
  State,
  UInt64,
  method,
  state
} from "o1js";

import {
  buildRegistryAgentCommitment,
  buildRegistryCapabilityCommitment,
  buildRegistryCapabilityDisableCommitment,
  buildRegistryPluginCommitment,
  buildRegistryStakeCommitment
} from "../shared/commitments.js";
import { appendRoot, emptyRoot } from "../shared/root-helpers.js";

export class RegistryKernel extends SmartContract {
  @state(Field) agentRoot = State<Field>();
  @state(Field) capabilityRoot = State<Field>();
  @state(Field) pluginRoot = State<Field>();
  @state(Field) policyTemplateRoot = State<Field>();
  @state(Field) stakeRoot = State<Field>();
  @state(UInt64) registryEpoch = State<UInt64>();

  events = {
    agentRegistered: Field,
    capabilityRegistered: Field,
    pluginRegistered: Field,
    capabilityDisabled: Field
  };

  init() {
    super.init();
    const root = emptyRoot();
    this.agentRoot.set(root);
    this.capabilityRoot.set(root);
    this.pluginRoot.set(root);
    this.policyTemplateRoot.set(root);
    this.stakeRoot.set(root);
    this.registryEpoch.set(UInt64.from(0));
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof()
    });
  }

  @method async registerAgent(
    agentIdHash: Field,
    ownerHash: Field,
    manifestHash: Field,
    pricingHash: Field,
    policyClassHash: Field,
    stakeAmount: UInt64,
    statusHash: Field,
    metadataHash: Field
  ) {
    const agentLeaf = buildRegistryAgentCommitment(
      agentIdHash,
      ownerHash,
      manifestHash,
      pricingHash,
      policyClassHash,
      stakeAmount,
      statusHash,
      metadataHash
    );
    const current = this.agentRoot.getAndRequireEquals();
    const next = appendRoot(current, agentLeaf);
    this.agentRoot.set(next);

    const currentStake = this.stakeRoot.getAndRequireEquals();
    this.stakeRoot.set(appendRoot(currentStake, buildRegistryStakeCommitment(agentIdHash, stakeAmount, policyClassHash)));
    this.emitEvent("agentRegistered", next);
  }

  @method async registerCapability(
    capabilityIdHash: Field,
    pluginIdHash: Field,
    manifestHash: Field,
    ioSchemaHash: Field,
    policyClassHash: Field,
    priceModelHash: Field,
    stakeAmount: UInt64,
    statusHash: Field
  ) {
    const capabilityLeaf = buildRegistryCapabilityCommitment(
      capabilityIdHash,
      pluginIdHash,
      manifestHash,
      ioSchemaHash,
      policyClassHash,
      priceModelHash,
      stakeAmount,
      statusHash
    );
    const current = this.capabilityRoot.getAndRequireEquals();
    const next = appendRoot(current, capabilityLeaf);
    this.capabilityRoot.set(next);

    const currentStake = this.stakeRoot.getAndRequireEquals();
    this.stakeRoot.set(
      appendRoot(currentStake, buildRegistryStakeCommitment(capabilityIdHash, stakeAmount, policyClassHash))
    );
    this.emitEvent("capabilityRegistered", next);
  }

  @method async registerPlugin(
    pluginIdHash: Field,
    publisherHash: Field,
    manifestHash: Field,
    bondAmount: UInt64,
    statusHash: Field
  ) {
    const pluginLeaf = buildRegistryPluginCommitment(
      pluginIdHash,
      publisherHash,
      manifestHash,
      bondAmount,
      statusHash
    );
    const current = this.pluginRoot.getAndRequireEquals();
    const next = appendRoot(current, pluginLeaf);
    this.pluginRoot.set(next);

    const currentStake = this.stakeRoot.getAndRequireEquals();
    this.stakeRoot.set(appendRoot(currentStake, buildRegistryStakeCommitment(pluginIdHash, bondAmount, manifestHash)));
    this.emitEvent("pluginRegistered", next);
  }

  @method async disableCapability(
    capabilityIdHash: Field,
    reasonHash: Field,
    actorHash: Field,
    disabledAtSlot: UInt64
  ) {
    const current = this.capabilityRoot.getAndRequireEquals();
    const next = appendRoot(
      current,
      buildRegistryCapabilityDisableCommitment(capabilityIdHash, reasonHash, actorHash, disabledAtSlot)
    );
    this.capabilityRoot.set(next);
    this.emitEvent("capabilityDisabled", next);
  }
}
