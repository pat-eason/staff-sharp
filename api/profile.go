package main

import (
	"context"
	"slices"
	"strings"
)

var levels = map[string]float64{"senior": 2.4, "staff": 3.0, "senior_staff": 3.6, "principal": 4.1}
var goals = map[string]bool{"stay_sharp": true, "interview_prep": true, "promotion": true, "new_role": true}

func (s *Server) getProfile(ctx context.Context) (Profile, error) {
	var p Profile
	err := s.pool.QueryRow(ctx, `SELECT display_name, primary_language, extra_languages, focal_domains, primary_focus,
		archetype, level, years_experience, goal, stack, context, weekly_minutes, onboarded FROM profile WHERE id = 1`).
		Scan(&p.DisplayName, &p.PrimaryLanguage, &p.ExtraLanguages, &p.FocalDomains, &p.PrimaryFocus, &p.Archetype,
			&p.Level, &p.YearsExperience, &p.Goal, &p.Stack, &p.Context, &p.WeeklyMinutes, &p.Onboarded)
	return p, err
}

func (s *Server) putProfile(ctx context.Context, p Profile) (Profile, error) {
	t := s.tax
	p.DisplayName = strings.TrimSpace(p.DisplayName)
	if len(p.DisplayName) > 80 {
		return p, bad("name is too long")
	}
	if !t.hasKey(t.Languages, p.PrimaryLanguage) {
		return p, bad("choose a primary language")
	}
	extra := []string{}
	for _, l := range p.ExtraLanguages {
		if t.hasKey(t.Languages, l) && l != p.PrimaryLanguage && !slices.Contains(extra, l) {
			extra = append(extra, l)
		}
	}
	p.ExtraLanguages = extra
	focal := []string{}
	for _, d := range p.FocalDomains {
		if t.hasDomain(d) && !slices.Contains(focal, d) {
			focal = append(focal, d)
		}
	}
	p.FocalDomains = focal
	if p.PrimaryFocus != "" && !t.hasDomain(p.PrimaryFocus) {
		return p, bad("unknown primary focus")
	}
	if p.Archetype != "" && !t.hasKey(t.Archetypes, p.Archetype) {
		return p, bad("unknown archetype")
	}
	if _, ok := levels[p.Level]; !ok {
		p.Level = "staff"
	}
	if !goals[p.Goal] {
		p.Goal = "stay_sharp"
	}
	p.YearsExperience = max(0, min(50, p.YearsExperience))
	p.WeeklyMinutes = max(10, min(1200, p.WeeklyMinutes))
	if len(p.Stack) > 1000 || len(p.Context) > 4000 {
		return p, bad("stack or context is too long")
	}
	_, err := s.pool.Exec(ctx, `UPDATE profile SET display_name=$1, primary_language=$2, extra_languages=$3, focal_domains=$4,
		primary_focus=$5, archetype=$6, level=$7, years_experience=$8, goal=$9, stack=$10, context=$11, weekly_minutes=$12,
		onboarded=$13, updated_at=now() WHERE id = 1`,
		p.DisplayName, p.PrimaryLanguage, p.ExtraLanguages, p.FocalDomains, p.PrimaryFocus, p.Archetype, p.Level,
		p.YearsExperience, p.Goal, p.Stack, p.Context, p.WeeklyMinutes, p.Onboarded)
	return p, err
}
