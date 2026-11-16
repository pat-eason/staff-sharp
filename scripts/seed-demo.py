"""Seed a throwaway sharp-docs stack (WEB_PORT=8585, compose project sharp-docs) with an eight-week history for README screenshots.

Run only against the sharp-docs copy: it reads answer keys straight from that database. Never point it at your real stack."""
import json, os, random, subprocess, urllib.request

API = "http://localhost:8585/api"
PROJECT = ["docker", "compose", "-p", "sharp-docs"]
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(7)


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def sql(q):
    out = subprocess.run(PROJECT + ["exec", "-T", "db", "psql", "-U", "quiz", "-d", "quiz", "-At", "-c", q],
                         capture_output=True, text=True, cwd=REPO_ROOT, check=True)
    return out.stdout.strip()


def key(qid):
    return json.loads(sql(f"SELECT body FROM questions WHERE id = '{qid}'"))


def answer(item, p):
    """Answer one item correctly with probability p; confidence mostly tracks correctness, with a few blind spots."""
    q = item["question"]
    k = key(q["id"])
    good = random.random() < p
    t = q["type"]
    if t in ("mcq", "multi"):
        ids = [o["id"] for o in q["options"]]
        if good:
            sel = list(k["answer"])
        else:
            wrong = [i for i in ids if i not in k["answer"]]
            sel = [random.choice(wrong)] if t == "mcq" else k["answer"][:1] + wrong[:1]
        resp = {"selected": sel}
    elif t == "numeric":
        n = k["numeric"]["answer"]
        resp = {"value": round(n * (random.uniform(0.85, 1.2) if good else random.choice([0.2, 5.0])), 2)}
    elif t == "ordering":
        order = [i["id"] for i in k["items"]]
        if not good:
            order[0], order[-1] = order[-1], order[0]
        resp = {"order": order}
    elif t in ("code_review", "bug_hunt"):
        lang = q.get("codeLanguage")
        lines = k["issueLines"][lang]
        comments = []
        for iss in k["issues"]:
            if good or random.random() < 0.3:
                comments.append({"line": lines[iss["id"]][0], "text": iss["summary"] + ". " + iss["fix"], "severity": iss["severity"]})
        resp = {"comments": comments or [{"line": 2, "text": "Naming could be clearer here.", "severity": "minor"}]}
    else:
        pts = k["rubric"]["keyPoints"]
        chosen = pts if good else pts[: max(1, len(pts) // 3)]
        resp = {"text": "\n\n".join(chosen)}
        if t == "diagram":
            comps = [c.split("|")[0] for c in k["rubric"].get("requiredComponents", [])]
            nodes = [{"id": f"n{i}", "type": c, "label": c.replace("_", " ").title(), "x": 40 + i * 200, "y": 80 + (i % 2) * 90}
                     for i, c in enumerate(["client"] + comps)]
            edges = [{"id": f"e{i}", "source": nodes[i]["id"], "target": nodes[i + 1]["id"], "label": ""} for i in range(len(nodes) - 1)]
            resp["diagram"] = {"nodes": nodes, "edges": edges}
    conf = (3 if random.random() < 0.6 else 2) if good else (3 if random.random() < 0.15 else random.choice([1, 2]))
    call("POST", f"/items/{item['id']}/answer", {"response": resp, "confidence": conf, "timeSpentMs": int(q["estSeconds"] * 1000 * random.uniform(0.6, 1.3))})


def run_regiment(name, cfg, p, weeks_ago, finish_days=True):
    r = call("POST", "/regiments", {"name": name, "description": "", "config": cfg})
    for s in r["sessions"]:
        sess = call("POST", f"/sessions/{s['id']}/start")
        for it in sess["items"]:
            answer(it, p)
        call("POST", f"/sessions/{s['id']}/finish")
    # backdate everything this regiment produced
    days = weeks_ago * 7
    sql(f"""UPDATE session_items SET submitted_at = submitted_at - interval '{days} days' + (random() * interval '2 days')
            WHERE session_id IN (SELECT id FROM sessions WHERE regiment_id = '{r['id']}')""")
    sql(f"""UPDATE sessions SET started_at = started_at - interval '{days} days', completed_at = completed_at - interval '{days} days',
            scheduled_for = scheduled_for - {days} WHERE regiment_id = '{r['id']}'""")
    sql(f"UPDATE regiments SET created_at = created_at - interval '{days} days', completed_at = completed_at - interval '{days} days' WHERE id = '{r['id']}'")
    sql(f"UPDATE insights SET created_at = created_at - interval '{days} days' WHERE created_at > now() - interval '1 minute'")
    print(f"{name}: done ({weeks_ago} weeks ago)")
    return r["id"]


call("PUT", "/profile", {"displayName": "Jordan", "primaryLanguage": "go", "extraLanguages": ["ts"], "focalDomains": ["system_design", "debugging", "ai_systems"],
                         "primaryFocus": "distributed_systems", "archetype": "architect", "level": "staff", "yearsExperience": 13, "goal": "stay_sharp",
                         "stack": "Go services, Postgres, Kafka, Kubernetes on AWS, React", "context": "Platform architect for a 60-engineer org.",
                         "weeklyMinutes": 120, "onboarded": True})

# calibration, eight weeks ago
cal = call("POST", "/onboarding/calibration")
sess = call("POST", f"/sessions/{cal['sessionId']}/start")
for it in sess["items"]:
    answer(it, 0.85 if it["question"]["difficulty"] <= 3 else 0.35)
call("POST", f"/sessions/{cal['sessionId']}/finish")
sql(f"UPDATE session_items SET submitted_at = submitted_at - interval '56 days' WHERE session_id = '{cal['sessionId']}'")
sql(f"UPDATE regiments SET created_at = created_at - interval '56 days', completed_at = completed_at - interval '56 days' WHERE id = '{cal['regimentId']}'")
sql(f"UPDATE sessions SET completed_at = completed_at - interval '56 days', started_at = started_at - interval '56 days' WHERE regiment_id = '{cal['regimentId']}'")
sql("UPDATE insights SET created_at = created_at - interval '56 days' WHERE created_at > now() - interval '1 minute'")

mixed = ["mcq", "multi", "numeric", "ordering", "bug_hunt", "free_text", "code_review"]
plan = [
    ("Daily five", {"days": 2, "perDay": 5, "adaptive": True, "feedback": "immediate"}, 0.45, 7),
    ("Weak-spot week", {"days": 4, "perDay": 4, "adaptive": True, "feedback": "immediate", "types": mixed}, 0.52, 6),
    ("Distributed deep dive", {"days": 2, "perDay": 5, "domains": ["distributed_systems", "system_design"], "feedback": "immediate"}, 0.58, 4),
    ("Speed round", {"days": 1, "perDay": 10, "timed": True, "timeLimitMinutes": 12, "types": ["mcq", "multi", "numeric"], "feedback": "end"}, 0.63, 3),
    ("Interview loop", {"days": 1, "perDay": 5, "timed": True, "timeLimitMinutes": 75, "types": ["diagram", "code_review", "free_text", "numeric", "bug_hunt"], "difficultyMin": 3, "difficultyMax": 5, "feedback": "end"}, 0.66, 2),
    ("Follow-up: debugging and AI systems", {"days": 3, "perDay": 4, "domains": ["debugging", "ai_systems", "security"], "adaptive": True, "feedback": "immediate"}, 0.74, 1),
    ("Daily five", {"days": 1, "perDay": 5, "adaptive": True, "feedback": "immediate"}, 0.8, 0),
]
for name, cfg, p, w in plan:
    run_regiment(name, cfg, p, w)

# In progress: a multi-day plan (day 1 done) and a timed set for the watch screenshot.
wk = call("POST", "/regiments", {"name": "Thirty-day sharpening", "description": "", "config": {"days": 30, "perDay": 3, "adaptive": True, "feedback": "immediate"}})
s1 = call("POST", f"/sessions/{wk['sessions'][0]['id']}/start")
for it in s1["items"]:
    answer(it, 0.75)
call("POST", f"/sessions/{wk['sessions'][0]['id']}/finish")
timed = call("POST", "/regiments", {"name": "Interview loop", "description": "", "config": {"days": 1, "perDay": 5, "timed": True, "timeLimitMinutes": 75,
                                    "types": ["code_review", "diagram", "free_text", "bug_hunt", "mcq"], "difficultyMin": 3, "difficultyMax": 5, "feedback": "end"}})
call("POST", f"/sessions/{timed['sessions'][0]['id']}/start")
drill = call("POST", "/regiments", {"name": "Practice", "description": "", "config": {"days": 1, "perDay": 6, "types": ["code_review", "ordering", "mcq", "diagram"], "feedback": "immediate", "domains": ["code_quality", "delivery", "system_design"]}})
call("POST", f"/sessions/{drill['sessions'][0]['id']}/start")
print(json.dumps({"timed": timed["sessions"][0]["id"], "drill": drill["sessions"][0]["id"], "week": wk["id"]}))
