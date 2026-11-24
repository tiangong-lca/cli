import { copyJson, isRecord, type JsonObject } from './base.js';

const modelInfoFields = [
  'common:generalComment',
  'classificationInformation',
  'referenceToExternalDocumentation',
] as const;

const rightsFields = [
  'common:referenceToOwnershipOfDataSet',
  'common:copyright',
  'common:licenseType',
  'common:accessRestrictions',
] as const;

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

/** Project whole-system declarations before adding generated provenance. */
export function applyModelDeclarations(model: JsonObject, process: JsonObject): void {
  const modelInfo = record(record(model.lifeCycleModelInformation).dataSetInformation);
  const processInfo = record(process.processInformation);
  const dataInfo = record(processInfo.dataSetInformation);
  for (const key of modelInfoFields) {
    if (Object.hasOwn(modelInfo, key)) {
      process.processInformation = processInfo;
      processInfo.dataSetInformation = dataInfo;
      dataInfo[key] = copyJson(modelInfo[key]);
    }
  }

  const modelTreatment = record(record(model.modellingAndValidation).dataSourcesTreatmentEtc);
  if (Object.hasOwn(modelTreatment, 'useAdviceForDataSet')) {
    const modelling = record(process.modellingAndValidation);
    const treatment = record(modelling.dataSourcesTreatmentAndRepresentativeness);
    process.modellingAndValidation = modelling;
    modelling.dataSourcesTreatmentAndRepresentativeness = treatment;
    const advice = modelTreatment.useAdviceForDataSet;
    if (Array.isArray(advice) && advice.length === 0) delete treatment.useAdviceForDataSet;
    else treatment.useAdviceForDataSet = copyJson(advice);
  }

  const modelAdmin = record(model.administrativeInformation);
  const admin = record(process.administrativeInformation);
  const modelGoal = record(modelAdmin['common:commissionerAndGoal']);
  if (Object.hasOwn(modelGoal, 'common:intendedApplications')) {
    const goal = record(admin['common:commissionerAndGoal']);
    process.administrativeInformation = admin;
    admin['common:commissionerAndGoal'] = goal;
    goal['common:intendedApplications'] = copyJson(modelGoal['common:intendedApplications']);
    if (Object.hasOwn(modelGoal, 'common:referenceToCommissioner'))
      goal['common:referenceToCommissioner'] = copyJson(
        modelGoal['common:referenceToCommissioner'],
      );
  }

  const modelRights = record(modelAdmin.publicationAndOwnership);
  if (rightsFields.some((key) => Object.hasOwn(modelRights, key))) {
    const publication = record(admin.publicationAndOwnership);
    process.administrativeInformation = admin;
    admin.publicationAndOwnership = publication;
    // A declaration about the whole system cannot be completed with the
    // component's rights. Missing required fields surface in validation.
    for (const key of rightsFields) {
      delete publication[key];
      if (Object.hasOwn(modelRights, key)) {
        const value = modelRights[key];
        if (key === 'common:accessRestrictions' && Array.isArray(value) && value.length === 0)
          continue;
        publication[key] = copyJson(value);
      }
    }
  }
}
