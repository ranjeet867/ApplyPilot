// ─────────────────────────────────────────────
//  ApplyPilot — shared TypeScript types
// ─────────────────────────────────────────────

export type JobStatus       = 'new' | 'opened' | 'applied' | 'skipped' | 'failed';
export type AutomationMode  = 'off' | 'assist' | 'semi-auto' | 'full-auto';
export type WorkMode        = 'remote' | 'hybrid' | 'onsite' | 'flexible';
export type AIProvider      = 'anthropic' | 'openai';

export type ATSPlatform =
  | 'greenhouse' | 'lever' | 'ashby' | 'workday'
  | 'smartrecruiters' | 'jobvite' | 'icims' | 'breezy'
  | 'recruitee' | 'personio' | 'join' | 'linkedin'
  | 'indeed' | 'stepstone' | 'xing' | 'bamboohr'
  | 'taleo' | 'generic';

// ── Job ─────────────────────────────────────
export interface Job {
  id:           string;
  title:        string;
  company:      string;
  location:     string;
  applyUrl:     string;
  sourceUrl:    string;
  sourceDomain: string;
  status:       JobStatus;
  notes:        string;
  savedAt:      number;
  appliedAt?:   number;
  salary?:      string;
  jobType?:     string;
  description?: string;
  coverLetter?: string;
  postedDate?:  string;
  remote?:      boolean;
}

// ── Queue state ───────────────────────────────
export interface QueueState {
  jobIds:    string[];
  current:   number;
  tabId?:    number;
  active:    boolean;
  autoMode?: boolean;  // true = auto-advance after fill (no user click needed)
}

// ── User profile ─────────────────────────────
export interface UserProfile {
  name:                 string;
  firstName:            string;
  lastName:             string;
  email:                string;
  phone:                string;
  city:                 string;
  country:              string;
  salaryMin:            string;
  salaryMax:            string;
  salaryCurrency:       string;
  noticePeriod:         string;
  noticePeriodUnit:     'days' | 'weeks' | 'months';
  earliestJoiningDate:  string;
  workModePreference:   WorkMode;
  relocationPreference: boolean;
  germanPR:             boolean;
  noVisaSponsorship:    boolean;
  workPermitType:       string;   // e.g. 'german_pr', 'blue_card', 'eu_citizen', 'need_sponsorship'
  gender:               string;   // e.g. 'Male', 'Female', 'Non-binary', 'Prefer not to say'
  raceEthnicity:        string;   // e.g. 'Asian', 'White', 'Decline to self-identify'
  veteranStatus:        string;   // e.g. 'No', 'Yes', 'Decline'
  disabilityStatus:     string;   // e.g. 'No', 'Yes', 'Decline'
  ageRange:             string;   // e.g. "30's", "40's"
  dateOfBirth:          string;   // ISO date string e.g. '1990-05-15'
  linkedinUrl:          string;
  githubUrl:            string;
  portfolioUrl:         string;
  targetRoles:          string[];
  targetLocations:      string[];
  skills:               string[];
  yearsOfExperience:    string;
  currentJobTitle:      string;
  currentCompany:       string;
  summary:              string;
}

// ── Settings ─────────────────────────────────
export interface Settings {
  openaiApiKey:            string;
  anthropicApiKey:         string;
  automationMode:          AutomationMode;
  aiProvider:              AIProvider;
  aiModel:                 string;
  resumeFileName:          string;
  resumeText:              string;
  resumeDataUrl:           string;
  coverLetterFileName:     string;
  coverLetterDataUrl:      string;
  profile:                 UserProfile;
  jobSearchKeywords:       string[];
  jobSearchLocations:      string[];
  maxJobAgeDays:           number;
  enableGmailDetection:    boolean;
  enableLinkedInDetection: boolean;
  /** Master on/off switch — when false, content script does nothing */
  enabled:                 boolean;
  /** Domains where ApplyPilot should never activate (user-managed blocklist) */
  disabledSites:           string[];
  /** When true, only activate on known job/ATS domains (recommended) */
  smartActivation:         boolean;
}

// ── Field detection ───────────────────────────
export type FieldType =
  | 'firstName' | 'lastName' | 'fullName'
  | 'email' | 'phone'
  | 'city' | 'country' | 'address'
  | 'salary' | 'salaryMin' | 'salaryMax'
  | 'noticePeriod' | 'joiningDate'
  | 'dateOfBirth'
  | 'workMode' | 'relocation'
  | 'workAuthorization' | 'visaSponsorship'
  | 'linkedin' | 'github' | 'portfolio'
  | 'resume' | 'coverLetter'
  | 'yearsOfExperience'
  | 'gender'
  | 'race'
  | 'veteranStatus'
  | 'disabilityStatus'
  | 'unknown';

export interface DetectedField {
  type:       FieldType;
  element:    HTMLElement;
  inputType:  'input' | 'textarea' | 'select' | 'file';
  label:      string;
  confidence: number;
  fillValue?: string;
}

// ── Jobs extracted from Gmail / LinkedIn ─────
export interface ExtractedJob {
  title:       string;
  company:     string;
  location:    string;
  applyUrl:    string;
  sourceUrl:   string;
  postedDate?: string;
  salary?:     string;
  remote?:     boolean;
}

// ── Extension messages ────────────────────────
export type MessageType =
  | 'JOBS_EXTRACTED'
  | 'GET_SETTINGS'
  | 'SETTINGS_RESPONSE'
  | 'FILL_APPLICATION'
  | 'FILL_RESPONSE'
  | 'GENERATE_COVER_LETTER'
  | 'COVER_LETTER_RESPONSE'
  | 'MARK_JOB_OPENED'
  | 'CHECK_DUPLICATE_URL'
  | 'DUPLICATE_CHECK_RESPONSE'
  | 'GET_JOBS'
  | 'JOBS_RESPONSE'
  | 'OPEN_OPTIONS'
  | 'OPEN_AND_APPLY'
  | 'TRIGGER_PANEL'
  | 'TOGGLE_PANEL'
  | 'GET_DETECTED_FIELDS'
  | 'SHOW_FILL_PANEL'
  | 'SAVE_COVER_LETTER'
  | 'QUEUE_START'
  | 'QUEUE_ADVANCE'
  | 'QUEUE_SKIP'
  | 'QUEUE_GET_STATE'
  | 'QUEUE_CLEAR'
  | 'CLICK_SELECTOR'
  | 'DETECT_JOB_ON_PAGE'
  | 'INJECT_FILE_MAIN_WORLD'
  | 'IFRAME_FIELDS_DETECTED'
  | 'FILL_IFRAME_FIELDS';

export interface ExtensionMessage {
  type:     MessageType;
  payload?: unknown;
}

export interface FillApplicationPayload {
  profile:      UserProfile;
  resumeText:   string;
  resumeFile?:  { name: string; dataUrl: string };
  coverLetter?: string;
}

export interface CoverLetterPayload {
  jobTitle:        string;
  company:         string;
  location:        string;
  jobDescription:  string;
  resumeText:      string;
  profile:         UserProfile;
}

export interface TriggerPanelPayload {
  queuePos?:    number;
  queueTotal?:  number;
  autoFill?:    boolean;
  autoMode?:    boolean;    // true = auto-advance after N seconds without user click
  coverLetter?: string;    // pre-generated by background before opening the tab
  jobTitle?:    string;    // for display in panel
  company?:     string;
  done?:        boolean;   // queue completed
  stuckAbort?:  boolean;   // stuck-detection aborted this job
  reason?:      string;    // reason for abort
}

export interface QueueStartPayload {
  jobIds:    string[];
  autoMode?: boolean;
}

// ── DB record for IndexedDB resume storage ────
export interface ResumeRecord {
  id:         'resume';
  fileName:   string;
  fileSize:   number;
  mimeType:   string;
  dataUrl:    string;
  text:       string;
  uploadedAt: number;
}

// ── Stats ─────────────────────────────────────
export interface ApplicationStats {
  total:    number;
  applied:  number;
  new:      number;
  skipped:  number;
  failed:   number;
  thisWeek: number;
  /** Number of applications per day (last 7 days), ordered Sun–Sat or by date */
  dailyCounts: Array<{ date: string; count: number }>;
  /** Applications grouped by source domain */
  bySource: Array<{ source: string; count: number }>;
  /** Current consecutive-day streak of at least 1 application */
  streak: number;
  /** Today's applied count */
  today: number;
}
