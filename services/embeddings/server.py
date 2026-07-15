from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from typing import List

app = FastAPI()
model = SentenceTransformer(
    "all-MiniLM-L6-v2",
    cache_folder="/models"
)

class EmbedRequest(BaseModel):
    texts: List[str]

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/embed")
def embed(req: EmbedRequest):
    embeddings = model.encode(req.texts).tolist()
    return {"embeddings": embeddings, "dimension": len(embeddings[0])}
