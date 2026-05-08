import React from 'react';
import type { UserProfile } from '../../types';
import TagsInput from './TagsInput';

interface Props {
  profile:  UserProfile;
  onChange: (patch: Partial<UserProfile>) => void;
}

export default function ProfileForm({ profile, onChange }: Props) {
  return (
    <>
      {/* Personal info */}
      <div className="card">
        <div className="card-title">👤 Personal Information</div>
        <div className="form-grid">
          <div className="field-group">
            <label>First name</label>
            <input
              type="text"
              value={profile.firstName}
              onChange={(e) => {
                onChange({ firstName: e.target.value, name: `${e.target.value} ${profile.lastName}`.trim() });
              }}
              placeholder="First name"
            />
          </div>
          <div className="field-group">
            <label>Last name</label>
            <input
              type="text"
              value={profile.lastName}
              onChange={(e) => {
                onChange({ lastName: e.target.value, name: `${profile.firstName} ${e.target.value}`.trim() });
              }}
              placeholder="Last name"
            />
          </div>
          <div className="field-group">
            <label>Email</label>
            <input
              type="email"
              value={profile.email}
              onChange={(e) => onChange({ email: e.target.value })}
              placeholder="your@email.com"
            />
          </div>
          <div className="field-group">
            <label>Phone</label>
            <input
              type="tel"
              value={profile.phone}
              onChange={(e) => onChange({ phone: e.target.value })}
              placeholder="+49 xxx xxx xxxx"
            />
          </div>
          <div className="field-group">
            <label>City</label>
            <input
              type="text"
              value={profile.city}
              onChange={(e) => onChange({ city: e.target.value })}
              placeholder="City"
            />
          </div>
          <div className="field-group">
            <label>Country</label>
            <input
              type="text"
              value={profile.country}
              onChange={(e) => onChange({ country: e.target.value })}
              placeholder="Germany"
            />
          </div>
        </div>
      </div>

      {/* Professional */}
      <div className="card">
        <div className="card-title">💼 Professional Details</div>
        <div className="form-grid">
          <div className="field-group">
            <label>Current job title</label>
            <input
              type="text"
              value={profile.currentJobTitle}
              onChange={(e) => onChange({ currentJobTitle: e.target.value })}
              placeholder="e.g. Senior Software Engineer"
            />
          </div>
          <div className="field-group">
            <label>Current company</label>
            <input
              type="text"
              value={profile.currentCompany}
              onChange={(e) => onChange({ currentCompany: e.target.value })}
              placeholder="e.g. Acme GmbH"
            />
          </div>
          <div className="field-group">
            <label>Years of experience</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={profile.yearsOfExperience}
              onChange={(e) => onChange({ yearsOfExperience: e.target.value.replace(/[^0-9]/g, '') })}
              placeholder="6"
              style={{ maxWidth: 100 }}
            />
          </div>
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Professional summary (used in cover letters)</label>
          <textarea
            rows={3}
            value={profile.summary}
            onChange={(e) => onChange({ summary: e.target.value })}
            placeholder="2–3 sentences: your strongest selling points, relevant tech stack, and unique value prop…"
          />
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Skills</label>
          <TagsInput
            tags={profile.skills}
            onChange={(skills) => onChange({ skills })}
            placeholder="Add skill (e.g. Go, Kubernetes, PHP)…"
          />
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Target roles</label>
          <TagsInput
            tags={profile.targetRoles}
            onChange={(targetRoles) => onChange({ targetRoles })}
            placeholder="Add role (e.g. Platform Engineer, AI Engineer)…"
          />
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Target locations</label>
          <TagsInput
            tags={profile.targetLocations}
            onChange={(targetLocations) => onChange({ targetLocations })}
            placeholder="Add location (e.g. Berlin, Munich, Remote Germany)…"
          />
        </div>
      </div>

      {/* Salary & availability */}
      <div className="card">
        <div className="card-title">💰 Salary & Availability</div>
        <div className="form-grid thirds">
          <div className="field-group">
            <label>Min salary</label>
            <input
              type="text"
              value={profile.salaryMin}
              onChange={(e) => onChange({ salaryMin: e.target.value })}
              placeholder="80000"
            />
          </div>
          <div className="field-group">
            <label>Max salary</label>
            <input
              type="text"
              value={profile.salaryMax}
              onChange={(e) => onChange({ salaryMax: e.target.value })}
              placeholder="110000"
            />
          </div>
          <div className="field-group">
            <label>Currency</label>
            <select
              value={profile.salaryCurrency}
              onChange={(e) => onChange({ salaryCurrency: e.target.value })}
            >
              <option value="EUR">EUR €</option>
              <option value="USD">USD $</option>
              <option value="GBP">GBP £</option>
              <option value="CHF">CHF ₣</option>
            </select>
          </div>
        </div>

        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field-group">
            <label>Notice period</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number"
                min="0"
                value={profile.noticePeriod}
                onChange={(e) => onChange({ noticePeriod: e.target.value })}
                style={{ width: 80 }}
              />
              <select
                value={profile.noticePeriodUnit}
                onChange={(e) => onChange({ noticePeriodUnit: e.target.value as 'days'|'weeks'|'months' })}
              >
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
          </div>
          <div className="field-group">
            <label>Earliest joining date</label>
            <input
              type="date"
              value={profile.earliestJoiningDate}
              onChange={(e) => onChange({ earliestJoiningDate: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Work preferences */}
      <div className="card">
        <div className="card-title">🏠 Work Preferences & Status</div>

        <div className="form-grid">
          <div className="field-group">
            <label>Work mode preference</label>
            <select
              value={profile.workModePreference}
              onChange={(e) => onChange({ workModePreference: e.target.value as 'remote'|'hybrid'|'onsite'|'flexible' })}
            >
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
              <option value="flexible">Flexible</option>
            </select>
          </div>
          <div className="field-group">
            <label>Work permit type</label>
            <select
              value={profile.workPermitType}
              onChange={(e) => onChange({ workPermitType: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="citizen">Citizen</option>
              <option value="permanent_resident">Permanent Resident</option>
              <option value="work_permit">Work Permit / Visa</option>
              <option value="eu_citizen">EU Citizenship (free movement)</option>
              <option value="need_sponsorship">Need visa sponsorship</option>
            </select>
          </div>
          <div className="field-group">
            <label>Gender</label>
            <select
              value={profile.gender}
              onChange={(e) => onChange({ gender: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Non-binary">Non-Binary</option>
              <option value="Other">Other</option>
              <option value="Decline">Decline to self-identify</option>
            </select>
          </div>
          <div className="field-group">
            <label>Race / Ethnicity</label>
            <select
              value={profile.raceEthnicity}
              onChange={(e) => onChange({ raceEthnicity: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="Asian">Asian</option>
              <option value="Black">Black or African American</option>
              <option value="Hispanic">Hispanic or Latino</option>
              <option value="White">White</option>
              <option value="Native">American Indian or Alaska Native</option>
              <option value="Pacific">Native Hawaiian or Pacific Islander</option>
              <option value="Two or more">Two or More Races</option>
              <option value="Decline">Decline to self-identify</option>
            </select>
          </div>
          <div className="field-group">
            <label>Veteran Status</label>
            <select
              value={profile.veteranStatus}
              onChange={(e) => onChange({ veteranStatus: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="not a protected veteran">I am not a protected veteran</option>
              <option value="protected veteran">I identify as a protected veteran</option>
              <option value="Decline">Decline to self-identify</option>
            </select>
          </div>
          <div className="field-group">
            <label>Disability Status</label>
            <select
              value={profile.disabilityStatus}
              onChange={(e) => onChange({ disabilityStatus: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="No">No, I don't have a disability</option>
              <option value="Yes">Yes, I have a disability</option>
              <option value="Decline">Decline to self-identify</option>
            </select>
          </div>
          <div className="field-group">
            <label>Date of birth</label>
            <input
              type="date"
              value={profile.dateOfBirth}
              onChange={(e) => onChange({ dateOfBirth: e.target.value })}
            />
          </div>
          <div className="field-group">
            <label>Age range</label>
            <select
              value={profile.ageRange}
              onChange={(e) => onChange({ ageRange: e.target.value })}
            >
              <option value="">— Select —</option>
              <option value="20s">20's</option>
              <option value="30s">30's</option>
              <option value="40s">40's</option>
              <option value="50s">50's</option>
              <option value="60s">60's</option>
              <option value="prefer_not_to_say">I choose not to identify</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">✅ Legally authorized to work</div>
              <div className="toggle-desc">You are authorized to work in the country you're applying to — no sponsorship needed</div>
            </div>
            <input
              type="checkbox"
              checked={profile.noVisaSponsorship}
              onChange={(e) => onChange({ noVisaSponsorship: e.target.checked, germanPR: e.target.checked })}
            />
          </div>

          <div className="toggle-row">
            <div>
              <div className="toggle-label">🚚 Open to relocation</div>
              <div className="toggle-desc">Willing to relocate for the right role</div>
            </div>
            <input
              type="checkbox"
              checked={profile.relocationPreference}
              onChange={(e) => onChange({ relocationPreference: e.target.checked })}
            />
          </div>
        </div>
      </div>

      {/* Online profiles */}
      <div className="card">
        <div className="card-title">🌐 Online Profiles</div>
        <div className="form-grid">
          <div className="field-group">
            <label>LinkedIn URL</label>
            <input
              type="url"
              value={profile.linkedinUrl}
              onChange={(e) => onChange({ linkedinUrl: e.target.value })}
              placeholder="https://linkedin.com/in/…"
            />
          </div>
          <div className="field-group">
            <label>GitHub URL</label>
            <input
              type="url"
              value={profile.githubUrl}
              onChange={(e) => onChange({ githubUrl: e.target.value })}
              placeholder="https://github.com/…"
            />
          </div>
          <div className="field-group">
            <label>Portfolio / website</label>
            <input
              type="url"
              value={profile.portfolioUrl}
              onChange={(e) => onChange({ portfolioUrl: e.target.value })}
              placeholder="https://yoursite.dev"
            />
          </div>
        </div>
      </div>
    </>
  );
}
