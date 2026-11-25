export {
  apiErrorCodes,
  apiErrorSchema,
  addressSchema,
  createSubmissionFieldsSchema,
  externalIdSchema,
  EXTERNAL_ID_PATTERN,
  fieldErrorsFromZod,
  firstNameSchema,
  IMAGE_MAX_BYTES,
  imageMimeTypeSchema,
  imageMimeTypes,
  lastNameSchema,
  submissionImageSchema,
  submissionListSchema,
  submissionSchema,
  submissionStatusSchema,
  submissionStatuses,
} from "./submission.js";

export type {
  ApiErrorBody,
  CreateSubmissionFields,
  ImageMimeType,
  Submission,
  SubmissionImage,
  SubmissionList,
  SubmissionStatus,
} from "./submission.js";
