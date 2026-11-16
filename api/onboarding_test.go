package main

import "testing"

func calib(scores map[int][]float64) []attempt {
	var out []attempt
	for d, ss := range scores {
		for _, s := range ss {
			out = append(out, attempt{Difficulty: d, Score: s})
		}
	}
	return out
}

func TestEstimateTheta(t *testing.T) {
	cases := []struct {
		name   string
		scores map[int][]float64
		want   string
	}{
		{"misses everything", map[int][]float64{2: {0, 0, 0}, 3: {0, 0, 0}, 4: {0, 0, 0}, 5: {0, 0, 0}}, "senior"},
		{"strong senior", map[int][]float64{2: {1, 1, 1}, 3: {1, 0, 0}, 4: {0, 0, 0}, 5: {0, 0, 0}}, "senior"},
		{"solid staff", map[int][]float64{2: {1, 1, 1}, 3: {1, 1, 0}, 4: {1, 0, 0}, 5: {0, 0, 0}}, "staff"},
		{"senior staff", map[int][]float64{2: {1, 1, 1}, 3: {1, 1, 1}, 4: {1, 1, 0}, 5: {0, 1, 0}}, "senior_staff"},
		{"aces everything", map[int][]float64{2: {1, 1, 1}, 3: {1, 1, 1}, 4: {1, 1, 1}, 5: {1, 1, 1}}, "principal"},
	}
	prev := 0.0
	for _, c := range cases {
		theta := estimateTheta(calib(c.scores))
		if got := levelFor(theta); got != c.want {
			t.Errorf("%s: theta %.2f gives %s, want %s", c.name, theta, got, c.want)
		}
		if theta < prev {
			t.Errorf("%s: theta %.2f should not be below the weaker case (%.2f)", c.name, theta, prev)
		}
		prev = theta
	}
}

func TestEstimateThetaNoEvidenceIsStaff(t *testing.T) {
	if got := levelFor(estimateTheta(nil)); got != "staff" {
		t.Fatalf("with no answers the prior should land on staff, got %s", got)
	}
}
