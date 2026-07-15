FROM python:3.11-slim

WORKDIR /app

RUN python -m pip install --upgrade pip

# Install Torch first
RUN pip install --no-cache-dir \
    torch \
    --index-url https://download.pytorch.org/whl/cpu

# Then install remaining dependencies
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    sentence-transformers

COPY server.py .

RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

EXPOSE 8001

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]