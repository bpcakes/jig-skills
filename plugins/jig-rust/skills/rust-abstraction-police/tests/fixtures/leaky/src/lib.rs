use serde::{Deserialize, Serialize};
use std::ops::Deref;

#[derive(Serialize, Deserialize)]
pub struct User {
    pub id: uuid::Uuid,
    pub row: sqlx::postgres::PgRow,
}

pub type Users = Vec<User>;

pub enum StoreError {
    Database(sqlx::Error),
}

pub trait UserStore {
    fn begin(
        &self,
    ) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, sqlx::Error>;
}

pub struct Validated(Vec<String>);

impl Deref for Validated {
    type Target = Vec<String>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Validated {
    pub fn into_inner(self) -> Vec<String> {
        self.0
    }
}

#[cfg(feature = "tokio-runtime")]
pub fn spawn_worker() -> tokio::task::JoinHandle<()> {
    todo!()
}

#[repr(transparent)]
pub struct Id(pub uuid::Uuid);

#[doc(hidden)]
pub fn macro_support() {}

#[macro_export]
macro_rules! make_user {
    ($id:expr) => {
        crate::User {
            id: $id,
            row: sqlx::postgres::PgRow::default(),
        }
    };
}

pub unsafe fn from_raw(ptr: *mut std::ffi::c_void) -> Id {
    todo!()
}

pub struct Service<Store, Clock, Executor> {
    pub store: Store,
    pub clock: Clock,
    pub executor: Executor,
}

fn consumer(value: Validated, error: Box<dyn std::error::Error>) {
    let _ = value.into_inner();
    let _ = error.downcast_ref::<sqlx::Error>();
}
